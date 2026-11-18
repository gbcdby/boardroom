import assert from "node:assert/strict";
import test from "node:test";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { LayoutValueError, checkLayoutPublicationValueJoin, copyLayoutInternalData, layoutValueDigest, parseLayoutIntentValue,
  parsePublicationBundleValue, parsePublicationRecipeValue } from "../src/server/storage/maintenance/layout-values.ts";

const hash = (value: string) => value.repeat(64);
const ref = (value: string) => ({ ref: `private/${value}`, sha256: hash(value), bytes: "1" });
const source = (kind: "sqlite" | "postgres", digit = "1") => ({ kind, databaseInstanceId: digit.repeat(32), identityDigest: hash(digit) });
const pathIdentity = (path: string) => ({ path, device: "1", inode: "2" });
const planned = (path: string) => ({ path, existingAncestor: pathIdentity("/"), absentSegments: path.slice(1).split("/") });
const rootRoles = ["home", "state", "memory", "skills", "runtime", "workspaces", "artifacts"] as const;
const fileRoles = ["config", "storage-marker", "migration-locator"] as const;
const memoryContractDigest = "cd93b64cd66516a22ef4173a343f03b6af6c2c459e1dd3fa2e7354bcf1fbe58a";

function fixture(mode: "retain-database" | "relocate-sqlite" | "initialize-new" = "retain-database", kind: "sqlite" | "postgres" = "sqlite") {
  const identity = { migrationId: "migration-1", activationId: "activation-1", storageId: "storage:1",
    generation: 1, layoutVersion: 2, objectFormat: "utf8-sha256-v1", memoryFormatContract: ref("1") };
  const recipe = { contract: "layout-publication-recipe-value/r1", identity, mode,
    roots: Object.fromEntries(rootRoles.map(role => [role, planned(`/data/${role}`)])),
    database: kind === "sqlite" ? { kind, targetPath: "/data/state/boardroom.db", privateDescriptor: ref("2") }
      : { kind, locationId: hash("2"), privateDescriptor: ref("2") },
    targets: [{ role: "config", parentRole: "home", relativePath: "config.json" },
      { role: "storage-marker", parentRole: "state", relativePath: "storage.json" },
      { role: "migration-locator", parentRole: "state", relativePath: "migrations/migration-1.json" }],
    rendererContract: ref("3"), privateInputs: ref("4") };
  const origin = mode === "initialize-new" ? { kind: "new-space", explicitSelection: ref("5"), absenceObservation: ref("6") }
    : { kind: "legacy", source: source(kind), plan: ref("5"), snapshotReady: ref("6"), originalPrivateConfig: ref("7"), effectiveConfigDigest: hash("8") };
  const intent = { contract: "layout-intent-value/r1", identity, mode, origin, controlRoot: planned("/control"),
    recipeDigest: digestJson(recipe), inventoryDigest: hash("9"), transitionContract: ref("a"), allowedDeltaContract: ref("b"),
    memoryContractDigest, fixedSeedPlan: ref("c"), auditId: "audit-1", plannedAt: "2026-11-18T00:00:00.000Z" };
  const bundle = { contract: "layout-publication-bundle-value/r1", identity, mode,
    intentDigest: digestJson(intent), recipeDigest: digestJson(recipe), targetSource: source(kind, mode === "retain-database" ? "1" : "2"),
    provisioning: mode === "retain-database" ? null : ref("d"), rootBindingSet: ref("e"),
    roots: rootRoles.map(role => ({ role, identity: pathIdentity(`/data/${role}`), sourceProfile: ref("f") })),
    parents: fileRoles.map((role, index) => ({ role, identity: pathIdentity(index === 0 ? "/data/home" : index === 1 ? "/data/state" : "/data/state/migrations") })),
    files: fileRoles.map((role, index) => ({ role, bytes: ref(String(index + 1)) })) };
  return { intent, recipe, bundle };
}
function fails(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof LayoutValueError &&
    (code === undefined || error.code === code) && error.message === `layout_internal_value:${error.code}`);
}

test("LV-AC02/04: all five accepted mode/backend joins expose data consistency only", () => {
  for (const [mode, kind] of [["retain-database", "sqlite"], ["retain-database", "postgres"], ["relocate-sqlite", "sqlite"],
    ["initialize-new", "sqlite"], ["initialize-new", "postgres"]] as const) {
    const values = fixture(mode, kind);
    assert.deepEqual(checkLayoutPublicationValueJoin(values), { classification: "value-consistent",
      intentDigest: digestJson(values.intent), recipeDigest: digestJson(values.recipe), bundleDigest: digestJson(values.bundle) });
  }
});

test("LV-AC01: parsers copy and deeply freeze without touching caller state or invoking getters", () => {
  const values = fixture();
  const parsed = parsePublicationRecipeValue(values.recipe);
  assert.equal(Object.isFrozen(values.recipe), false);
  assert.equal(Object.isFrozen(values.recipe.identity), false);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.roots.home.absentSegments));
  values.recipe.identity.storageId = "caller-changed";
  assert.equal(parsed.identity.storageId, "storage:1");
  let calls = 0;
  for (const parser of [parseLayoutIntentValue, parsePublicationRecipeValue, parsePublicationBundleValue]) {
    fails(() => parser({ get contract() { calls++; return "private DSN"; } }), "invalid_value");
    fails(() => parser(Object.create({ inherited: true })), "invalid_value");
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    fails(() => parser(cycle), "invalid_value");
  }
  assert.equal(calls, 0);
});

test("LV-AC01/03: strict fields, data-only arrays, bounds and deterministic digests", () => {
  const values = fixture();
  for (const patch of [{ nativeIdentity: {} }, { intentDigest: hash("a") }, { futureRoot: {} }, { extra: undefined },
    { extra: NaN }, { extra: -0 }, { extra: new Array(2) }, { extra: "\ud800" }]) {
    fails(() => parsePublicationRecipeValue({ ...values.recipe, ...patch }));
  }
  for (const value of [Object.defineProperty({ ...values.recipe }, "hidden", { value: 1 }),
    { ...values.recipe, [Symbol("secret")]: 1 }]) fails(() => parsePublicationRecipeValue(value), "invalid_value");
  const reordered = Object.fromEntries(Object.entries(values.recipe).reverse());
  assert.equal(layoutValueDigest(parsePublicationRecipeValue(reordered)), digestJson(values.recipe));
  const changed = structuredClone(values.recipe); changed.identity.activationId = "activation-2";
  assert.notEqual(layoutValueDigest(parsePublicationRecipeValue(changed)), digestJson(values.recipe));
  fails(() => parsePublicationRecipeValue({ ...values.recipe, extra: "s".repeat(1_048_577) }), "budget_exceeded");
  let deep: unknown = null; for (let index = 0; index < 66; index++) deep = { deep };
  fails(() => parsePublicationRecipeValue(deep), "budget_exceeded");
  fails(() => parsePublicationRecipeValue({ extra: Array(250_001).fill(null) }), "budget_exceeded");
  fails(() => copyLayoutInternalData({}, "relaxed" as "value"), "invalid_value");
});

test("LV-AC02: incompatible backend, origin, retain and relocate relationships fail closed", () => {
  for (const kind of ["sqlite", "postgres"] as const) {
    const values = fixture("initialize-new", kind);
    values.bundle.targetSource = source(kind === "sqlite" ? "postgres" : "sqlite", "2");
    fails(() => checkLayoutPublicationValueJoin(values), "value_conflict");
  }
  const retain = fixture(); retain.bundle.targetSource.databaseInstanceId = "3".repeat(32);
  fails(() => checkLayoutPublicationValueJoin(retain), "value_conflict");
  const relocate = fixture("relocate-sqlite"); relocate.bundle.targetSource = source("sqlite");
  fails(() => checkLayoutPublicationValueJoin(relocate), "value_conflict");
  fails(() => checkLayoutPublicationValueJoin(fixture("relocate-sqlite", "postgres")), "value_conflict");
  const fresh = fixture("initialize-new");
  fails(() => parseLayoutIntentValue({ ...fresh.intent, origin: { ...fresh.intent.origin, source: source("sqlite") } }), "invalid_value");
  const legacy = fixture();
  legacy.intent.origin.source!.kind = "postgres";
  legacy.bundle.intentDigest = digestJson(legacy.intent);
  fails(() => checkLayoutPublicationValueJoin(legacy), "value_conflict");
});

test("LV-AC03/04: fixed targets, exact roots, observations, refs, provisioning and digest joins", () => {
  for (const mutate of [
    (values: ReturnType<typeof fixture>) => { values.recipe.targets[2]!.relativePath = "../outside"; },
    (values: ReturnType<typeof fixture>) => { values.bundle.roots.pop(); },
    (values: ReturnType<typeof fixture>) => { values.bundle.roots[0]!.identity.path = "/wrong"; },
    (values: ReturnType<typeof fixture>) => { values.bundle.parents[2]!.identity.path = "/data/state"; },
    (values: ReturnType<typeof fixture>) => { values.bundle.files[1]!.bytes = values.bundle.files[0]!.bytes; },
    (values: ReturnType<typeof fixture>) => { values.bundle.provisioning = ref("a"); },
    (values: ReturnType<typeof fixture>) => { values.bundle.recipeDigest = hash("a"); },
    (values: ReturnType<typeof fixture>) => { values.intent.memoryContractDigest = hash("a"); },
  ]) {
    const values = fixture(); mutate(values); fails(() => checkLayoutPublicationValueJoin(values));
  }
  const path = fixture().recipe;
  path.roots.home!.path = "/data//home";
  fails(() => parsePublicationRecipeValue(path), "invalid_value");
  const original = fixture();
  assert.deepEqual(parseLayoutIntentValue(original.intent), original.intent);
  assert.deepEqual(parsePublicationBundleValue(original.bundle), original.bundle);
});

test("LV-AC01/03/04: unsupported contracts remain distinct from malformed data and bounds are fixed", () => {
  const values = fixture();
  for (const [parser, value] of [[parseLayoutIntentValue, values.intent], [parsePublicationRecipeValue, values.recipe],
    [parsePublicationBundleValue, values.bundle]] as const) {
    fails(() => parser({ ...value, contract: "unassigned-future-contract" }), "unsupported_shape");
  }
  const nullPrototype = Object.assign(Object.create(null), values.recipe) as unknown;
  assert.deepEqual(parsePublicationRecipeValue(nullPrototype), parsePublicationRecipeValue(values.recipe));
  for (const role of ["roots", "parents", "files"] as const) {
    const altered = fixture(); altered.bundle[role].pop(); fails(() => checkLayoutPublicationValueJoin(altered));
  }
  for (const key of ["privateInputs", "rendererContract"] as const) {
    const altered = fixture().recipe; altered[key] = ref("9");
    assert.notEqual(layoutValueDigest(parsePublicationRecipeValue(altered)), digestJson(values.recipe));
  }
});

test("LV-AC01: public parsers consume one complete key snapshot for objects and arrays", () => {
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
  const input = fixture();
  for (const [parser, value] of [[parseLayoutIntentValue, input.intent], [parsePublicationRecipeValue, input.recipe],
    [parsePublicationBundleValue, input.bundle]] as const) {
    const expected = parser(value);
    const reflected = driftingKeys(structuredClone(value));
    assert.deepEqual(parser(reflected.proxy), expected);
    assert.equal(reflected.count(), 1);
    assert.equal(reflected.descriptorKeys.includes("callback"), false);
    fails(() => parser(reflected.target), "invalid_value");
    fails(() => parser(Object.defineProperty(structuredClone(value), "hidden", { value: true })), "invalid_value");
  }
  const recipe = fixture().recipe;
  const expected = parsePublicationRecipeValue(recipe);
  const reflected = driftingKeys(recipe.targets);
  recipe.targets = reflected.proxy;
  assert.deepEqual(parsePublicationRecipeValue(recipe), expected);
  assert.equal(reflected.count(), 1);
  assert.equal(reflected.descriptorKeys.includes("callback"), false);
  recipe.targets = reflected.target;
  fails(() => parsePublicationRecipeValue(recipe), "invalid_value");

  const missingDescriptor = new Proxy(fixture().recipe, {
    getOwnPropertyDescriptor(item, key) { return key === "privateInputs" ? undefined : Reflect.getOwnPropertyDescriptor(item, key); },
  });
  fails(() => parsePublicationRecipeValue(missingDescriptor), "invalid_value");
});

test("LV-AC01: public parsers sanitize hostile reflection errors without inspecting caller error properties", () => {
  let inspected = 0;
  const thrownProxy = new Proxy({}, { getPrototypeOf() { throw new Error("private-reflection-marker"); } });
  const modified = new LayoutValueError("invalid_value");
  modified.message = "private-modified-error";
  Object.assign(modified, { cause: "private-cause" });
  Object.defineProperty(modified, "code", { get() { inspected++; throw new Error("private-code-getter"); } });
  for (const parser of [parseLayoutIntentValue, parsePublicationRecipeValue, parsePublicationBundleValue]) {
    for (const thrown of [thrownProxy, modified]) {
      const input = new Proxy({}, { ownKeys() { throw thrown; } });
      assert.throws(() => parser(input), (error: unknown) => error instanceof LayoutValueError
        && error.code === "invalid_value" && error.message === "layout_internal_value:invalid_value" && !("cause" in error));
    }
  }
  assert.equal(inspected, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { buildLayoutPublicationFileValues } from "../src/server/storage/maintenance/layout-publication-file-values.ts";
import { canonicalJson, digestJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { parseConfigValues } from "../src/server/config.ts";
import { checkLayoutPublicationValueJoin, parseLayoutIntentValue, parsePublicationBundleValue,
  parsePublicationRecipeValue } from "../src/server/storage/maintenance/layout-values.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/layout-publication/e1-vectors.json", import.meta.url), "utf8"));
function vector(name = "sqlite-retain-database-present") {
  const fixture = fixtures.vectors.find((entry: { name: string }) => entry.name === name);
  return { input: structuredClone({ ...fixture.input, fixedSources: fixtures.fixedSources }), expected: fixture.output };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) frozen(item);
}

// Mutations retain independently valid bytes and all unchanged typed edges. Test expectations
// come from the accepted contract or frozen fixture, never from the new renderer's internals.
type Fixture = Record<string, any>;
const slots = ["plan", "seed", "original", "database", "rendererInputs", "recipe", "intent", "rootBindings"] as const;
function unpack(input: Fixture): Fixture {
  return Object.fromEntries(slots.map(slot => {
    const body = JSON.parse(Buffer.from(input[slot].bytesHex, "hex").toString("utf8"));
    return [slot, body.payload ?? body];
  }));
}
function bytesSlot(bytes: Buffer, old: Fixture): Fixture {
  const digest = sha256(bytes), pieces = old.artifact.ref.split("/");
  pieces[pieces.length - 2] = digest;
  return { artifact: { ref: pieces.join("/"), sha256: digest, bytes: String(bytes.length) }, bytesHex: bytes.toString("hex") };
}
function repack(input: Fixture, values: Fixture): Fixture {
  const replacements = new Map<string, Fixture>();
  const oldRecipeDigest = input.recipe.artifact.sha256;
  function replace(value: any): any {
    if (value === null || typeof value !== "object") return value;
    const match = replacements.get(canonicalJson(value));
    if (match) return structuredClone(match);
    return Array.isArray(value) ? value.map(replace) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
  }
  for (const slot of slots) {
    let payload = replace(values[slot]);
    if (slot === "intent" && payload.recipeDigest === oldRecipeDigest) payload.recipeDigest = input.recipe.artifact.sha256;
    const old = input[slot], body = JSON.parse(Buffer.from(old.bytesHex, "hex").toString("utf8"));
    if (Object.hasOwn(body, "payload")) payload = { ...body, payload };
    const next = bytesSlot(Buffer.from(canonicalJson(payload)), old);
    replacements.set(canonicalJson(old.artifact), next.artifact);
    input[slot] = next;
  }
  return input;
}
function mutate(change: (values: Fixture, input: Fixture) => void, name?: string): Fixture {
  const { input } = vector(name);
  const values = unpack(input);
  change(values, input);
  return repack(input, values);
}
function configInput(raw: string, env: Record<string, string | null> = {}, name?: string): Fixture {
  const { input } = vector(name), values = unpack(input);
  input.privateConfig = bytesSlot(Buffer.from(raw), input.privateConfig ?? {
    artifact: { ref: "s4-provider/sha256/placeholder/private-config-bytes.bin" } });
  values.plan.configDigest = input.privateConfig.artifact.sha256;
  values.original.raw = input.privateConfig.artifact;
  Object.assign(values.original.environment, env);
  return repack(input, values);
}
function privateText(input: Fixture): string { return Buffer.from(input.privateConfig.bytesHex, "hex").toString("utf8"); }
function success(input: unknown) {
  const result = buildLayoutPublicationFileValues(input);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.error));
  if (!result.ok) throw new Error("expected_success");
  return result.value;
}
function rejected(input: unknown, code?: string, ruleId?: string) {
  const result = buildLayoutPublicationFileValues(input);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected_failure");
  assert.deepEqual(Object.keys(result), ["ok", "error"]);
  assert.deepEqual(Object.keys(result.error), ["code", "ruleId", "schemaPath"]);
  if (code) assert.equal(result.error.code, code);
  if (ruleId) assert.equal(result.error.ruleId, ruleId);
  frozen(result);
  return result.error;
}

test("E1-AC01/09/10/11/13: the three supported branches and both absent configurations produce exact frozen files and joins", () => {
  for (const fixture of fixtures.vectors) {
    const { input, expected } = vector(fixture.name);
    const before = structuredClone(input);
    const result = buildLayoutPublicationFileValues(input);
    assert.deepEqual(result, { ok: true, value: expected }, fixture.name);
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(input.plan.artifact), false);
    assert.deepEqual(buildLayoutPublicationFileValues(input), result);
    frozen(result);
  }
});

test("E1-AC03/04/05: preserve private bytes and last duplicate token, honor the actual ten numeric winners", () => {
  const { input } = vector(), originalText = privateText(input);
  for (const token of ["4317", "4.317e3", "+4317", " 4317 ", "0x10dd", "0o10335", "0b1000011011101", "4317e+0", "4317e-0"])
    success(configInput(originalText, { AGENT_STUDIO_PORT: token }));
  for (const token of ["4317.00000000000000000001", "4316.99999999999999999999"])
    rejected(configInput(originalText, { AGENT_STUDIO_PORT: token }), "semantic_unsupported", "E1_NUMBER");
  const tokens = ["50.000000000000000001", "49.999999999999999999", "5.0000000000000000001e1"];
  for (const token of tokens) {
    rejected(configInput(originalText, { AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: token }), "semantic_unsupported", "E1_NUMBER");
    rejected(configInput(originalText.replace('"unknownHistorical":', `"memory":{"messageThreshold":${token}},"unknownHistorical":`)),
      "semantic_unsupported", "E1_NUMBER");
  }
  for (const key of ["AGENT_STUDIO_HEARTBEAT_INTERVAL_MS", "AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS",
    "AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES", "AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER",
    "AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES", "AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES",
    "AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES", "AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS"]) {
    const defaults: Record<string, string> = { AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "10000", AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: "30000",
      AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES: "6", AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER: "20",
      AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES: "32768", AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES: "8192",
      AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES: "65536", AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS: "900000" };
    rejected(configInput(originalText, { [key]: `${defaults[key]}.000000000000000001` }), "semantic_unsupported", "E1_NUMBER");
  }
  for (const rawToken of ["[4317.000000000000000001]", "[[4317.000000000000000001]]"])
    rejected(configInput(originalText.replace('"port": 4317', `"port": ${rawToken}`)), "semantic_unsupported", "E1_NUMBER");
  for (const rawToken of ["[4317]", "[[4317]]", '"+4317"']) success(configInput(originalText.replace('"port": 4317', `"port": ${rawToken}`)));
  // JSON.parse retains the final duplicate and its exact source token.
  success(configInput(originalText.replace('"port": 4317', '"port":4317.000000000000000001,"port":4317')));
  rejected(configInput(originalText.replace('"port": 4317', '"port":4317,"port":4317.000000000000000001')), "semantic_unsupported", "E1_NUMBER");
  const ignored = configInput(originalText.replace('"port": 4317', '"port":4317.000000000000000001'), { AGENT_STUDIO_PORT: "4317" });
  const before = privateText(ignored);
  success(ignored);
  assert.equal(privateText(ignored), before);
  rejected(configInput(originalText, { AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: "9007199254740991.1" }), "semantic_unsupported", "E1_NUMBER");
  rejected(configInput(originalText, { AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS: "9007199254740992" }), "semantic_unsupported", "E1_NUMBER");
  rejected(configInput(originalText, { AGENT_STUDIO_PORT: "1e" + "9".repeat(10_000) }), "invalid_value", "E1_CONFIG");
});

test("E1-AC01/13: hostile descriptors and reflection errors never run accessors or leak thrown data", () => {
  let getters = 0;
  for (const make of [
    () => Object.defineProperty({}, "contract", { enumerable: true, get() { getters++; return "secret"; } }),
    () => { const value: Fixture = {}; value.self = value; return value; },
    () => ({ fn() {} }), () => ({ value: Symbol("private") }), () => new Date(0), () => new Array(3),
    () => ({ [Symbol("private")]: true }), () => Object.defineProperty({}, "hidden", { value: 1 }),
    () => ({ number: -0 }), () => ({ number: Number.MAX_SAFE_INTEGER + 1 }),
  ]) rejected(make(), "invalid_value", "E1_INPUT");
  assert.equal(getters, 0);
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw new Error("secret DSN"); },
    getPrototypeOf() { reads++; throw new Error("secret path"); }, ownKeys() { reads++; throw new Error("secret ID"); } });
  for (const trap of ["ownKeys", "getPrototypeOf", "getOwnPropertyDescriptor"] as const) {
    const candidate = new Proxy(vector().input, { [trap]() { throw hostile; } });
    rejected(candidate, "invalid_value", "E1_INPUT");
  }
  assert.equal(reads, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  rejected(revoked.proxy, "invalid_value", "E1_INPUT");
  let enumerations = 0;
  const caller = new Proxy(vector().input, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  success(caller);
  assert.equal(enumerations, 1);
  rejected({ ...vector().input, extra: "secret" }, "invalid_value", "E1_INPUT");
  rejected({ ...vector().input, contract: "caller-registry" }, "unsupported_shape", "E1_INPUT");
});

test("E1-AC12: decoded nodes, raw JSON depth, per-item and aggregate bytes all use the request budget", () => {
  const { input } = vector(), raw = privateText(input);
  let nested: unknown = 0;
  for (let index = 0; index < 65; index++) nested = [nested];
  rejected(configInput(raw.replace('"unknownHistorical":', `"extra":${JSON.stringify(nested)},"unknownHistorical":`)), "resource_limit", "E1_BUDGET");
  const heavyPlan = mutate(values => { values.plan.preview.clientInventory = Array.from({ length: 130_000 }, () => null); });
  const heavyRaw = raw.replace('"unknownHistorical":', `"extra":[${Array.from({ length: 125_000 }, () => "0").join(",")}],"unknownHistorical":`);
  const all = configInput(heavyRaw), combined = unpack(all);
  combined.plan.preview.clientInventory = unpack(heavyPlan).plan.preview.clientInventory;
  rejected(repack(all, combined), "resource_limit", "E1_BUDGET");
  // No individual selected size exceeds 1 MiB, while their sum exceeds 8 MiB.
  const bytes = vector().input;
  for (const [index, slot] of [...slots, "privateConfig"].entries()) {
    const buffer = Buffer.alloc(1_048_576, index + 65);
    bytes[slot] = bytesSlot(buffer, bytes[slot]);
  }
  rejected(bytes, "resource_limit", "E1_BUDGET");
  const oversized = vector().input; oversized.privateConfig.bytesHex = "00".repeat(1_048_577);
  rejected(oversized, "resource_limit", "E1_BUDGET");
  const outer = vector().input; outer.plan.bytesHex = "0".repeat(32 * 1_048_576);
  rejected(outer, "resource_limit", "E1_BUDGET");
  const hugePlan = mutate(values => { values.plan.preview.clientInventory = Array.from({ length: 250_001 }, () => 0); });
  rejected(hugePlan, "resource_limit", "E1_BUDGET");
  const oldGuard = vector().input; oldGuard.originHistory.extra = "x".repeat(1_048_576);
  rejected(oldGuard, "resource_limit", "E1_BUDGET");
  // Leave room for every input/decoded value, but not the new output. This detects a
  // reset at the render boundary as well as a meter that ignores output nodes.
  function nodes(value: unknown): number {
    return 1 + (value !== null && typeof value === "object" ? Object.values(value).reduce<number>((sum, item) => sum + nodes(item), 0) : 0);
  }
  const empty = configInput(raw.replace('"unknownHistorical":', '"extra":[],"unknownHistorical":'));
  const inputNodes = nodes(empty) + slots.reduce((sum, slot) => sum + nodes(JSON.parse(Buffer.from(empty[slot].bytesHex, "hex").toString("utf8"))), 0)
    + nodes(JSON.parse(privateText(empty)));
  const count = 250_000 - inputNodes - 1;
  const almost = configInput(raw.replace('"unknownHistorical":', `"extra":[${"0,".repeat(count - 1)}0],"unknownHistorical":`));
  rejected(almost, "resource_limit", "E1_BUDGET");
  const enough = configInput(raw.replace('"unknownHistorical":', `"extra":[${"0,".repeat(count - 2001)}0],"unknownHistorical":`));
  success(enough);
});

test("E1-AC02: exact selected byte grammar, hashes, canonical envelopes and fixed roles", () => {
  const changes: [string, (input: Fixture) => void][] = [
    ["invalid_value", input => { input.plan.bytesHex = "FF"; }],
    ["invalid_value", input => { input.plan.bytesHex = "f"; }],
    ["artifact_integrity", input => { input.plan.artifact.bytes = "1"; }],
    ["artifact_integrity", input => { input.plan.artifact.sha256 = "0".repeat(64); }],
    ["invalid_value", input => { input.plan.artifact.bytes = "01259"; }],
    ["reference_conflict", input => { input.intent = structuredClone(input.plan); }],
    ["artifact_integrity", input => { input.seed.artifact.ref = "caller/seed.bin"; }],
    ["artifact_integrity", input => { input.privateConfig.artifact.ref = "caller/private.bin"; }],
    ["reference_conflict", input => { [input.fixedSources.renderer, input.fixedSources.transition] = [input.fixedSources.transition, input.fixedSources.renderer]; }],
    ["reference_conflict", input => { input.fixedSources.memory.artifact.ref = "caller/fixed-contract-source.bin"; }],
    ["artifact_integrity", input => { input.fixedSources.allowedDelta.bytesHex = "00" + input.fixedSources.allowedDelta.bytesHex.slice(2); }],
  ];
  for (const [code, change] of changes) { const { input } = vector(); change(input); rejected(input, code); }
  const seedText = Buffer.from(vector().input.seed.bytesHex, "hex").toString("utf8");
  for (const text of [seedText + "\n", seedText + " ", seedText.replace('"formatVersion":1,', '"formatVersion":1,"formatVersion":1,')]) {
    const { input } = vector(); input.seed = bytesSlot(Buffer.from(text), input.seed);
    rejected(input, "artifact_integrity", "E1_BYTES");
  }
  for (const bytes of [Buffer.from("\uFEFF" + seedText), Buffer.from([0xff, 0xfe]), Buffer.from('{"x":"\\ud800"}'), Buffer.from('{"x":-0}'), Buffer.from('{"x":9007199254740992}')]) {
    const { input } = vector(); input.seed = bytesSlot(bytes, input.seed);
    rejected(input, "invalid_value", "E1_BYTES");
  }
  for (const change of [(body: Fixture) => { body.kind = "caller-codec"; }, (body: Fixture) => { body.formatVersion = 2; }]) {
    const { input } = vector(), body = JSON.parse(seedText); change(body);
    input.seed = bytesSlot(Buffer.from(canonicalJson(body)), input.seed);
    rejected(input, "unsupported_shape", "E1_BYTES");
  }
  rejected(mutate(values => { values.seed.contract = "s4p-fixed-seed/r1"; }), "unsupported_shape", "E1_SEED");
  rejected(mutate(values => { values.rendererInputs.extra = "secret"; }), "invalid_value", "E1_BINDING");
});

test("E1-AC03/04/06: raw presence, full environment keys and independently recomputed effective values", () => {
  const { input } = vector(), text = privateText(input);
  for (const raw of ["", "\uFEFF{}", "null", "[]", "true", "{", '{"port":"private secret"}'])
    rejected(configInput(raw), "invalid_value", "E1_CONFIG");
  rejected({ ...input, privateConfig: null }, "value_conflict", "E1_CONFIG");
  const absent = vector("sqlite-retain-database-absent").input;
  absent.privateConfig = input.privateConfig;
  rejected(absent, "value_conflict", "E1_CONFIG");
  for (const change of [
    (values: Fixture) => { delete values.original.environment.AGENT_STUDIO_PORT; },
    (values: Fixture) => { values.original.environment.HOME = "/secret"; },
    (values: Fixture) => { values.original.environment.AGENT_STUDIO_PORT = 4317; },
  ]) rejected(mutate(change), "invalid_value", "E1_CONFIG");
  for (const change of [
    (values: Fixture) => { values.original.originalCwd = "/somewhere"; },
    (values: Fixture) => { values.original.filePathBase = "/somewhere"; },
    (values: Fixture) => { values.original.path = "/somewhere/config.json"; },
    (values: Fixture) => { values.original.raw.bytes = "999"; },
    (values: Fixture) => { values.original.effective.settings.port = 4318; },
    (values: Fixture) => { values.plan.effectiveConfigDigest = "0".repeat(64); },
    (values: Fixture) => { values.original.effectiveConfigDigest = "0".repeat(64); },
    (values: Fixture) => { values.intent.origin.effectiveConfigDigest = "0".repeat(64); },
  ]) rejected(mutate(change), "value_conflict", "E1_CONFIG");
  rejected(mutate(values => { values.plan.sourceIdentity.sqlitePath = "/other/source.db"; }), "value_conflict", "E1_BINDING");
  const staleEffective = configInput(text, { AGENT_STUDIO_PORT: "4318" });
  rejected(staleEffective, "value_conflict", "E1_CONFIG");
  // The config parser's supported coercion remains valid when it is mathematically exact.
  const boolean = configInput(text.replace('"port": 4317', '"port":true')), values = unpack(boolean);
  values.original.effective.settings.port = 1;
  values.rendererInputs.settings.port = 1;
  const digest = digestJson({ ...values.original.effective.settings, dataDir: "/origin/data", dbDriver: "sqlite",
    postgresConnectionDigest: null, postgresSchema: null });
  values.plan.effectiveConfigDigest = values.original.effectiveConfigDigest = values.intent.origin.effectiveConfigDigest = digest;
  success(repack(boolean, values));
  const nondefaultSettings = { port: 9876, heartbeat: { intervalMs: 2000, timeoutMs: 8000 },
    antiLoop: { maxConsecutiveAutoReplies: 2, maxWakesPerMinutePerMember: 9 },
    memory: { messageThreshold: 13, maxDocumentBytes: 4096, maxInjectedBytes: 1024, summaryInputBytes: 4096, summaryAttemptTimeoutMs: 60000 } };
  const configured = configInput(JSON.stringify({ ...nondefaultSettings, port: 1234, dataDir: "data", dbDriver: "sqlite",
    pgConnectionString: "  postgresql://fixture:synthetic@localhost/e1  " }), { AGENT_STUDIO_PORT: "9876" });
  const configuredValues = unpack(configured);
  configuredValues.original.effective.settings = structuredClone(nondefaultSettings);
  configuredValues.rendererInputs.settings = structuredClone(nondefaultSettings);
  const configuredDigest = digestJson({ ...nondefaultSettings, dataDir: "/origin/data", dbDriver: "sqlite",
    postgresConnectionDigest: null, postgresSchema: null });
  configuredValues.plan.effectiveConfigDigest = configuredValues.original.effectiveConfigDigest = configuredValues.intent.origin.effectiveConfigDigest = configuredDigest;
  const configuredOutput = success(repack(configured, configuredValues));
  const publicConfig = JSON.parse(Buffer.from(configuredOutput.files[0]!.bytesHex, "hex").toString("utf8"));
  for (const [key, value] of Object.entries(nondefaultSettings)) assert.deepEqual(publicConfig[key], value);
});

test("E1-AC07: preserved PA UTF16 IDs and new layout IDs stay in their distinct domains", () => {
  function historical(id: string) {
    return mutate((values, input) => {
      values.seed.originalProfileActivationId = id;
      input.originHistory.activation.activationId = input.originHistory.completion.activation.activationId = id;
    });
  }
  for (const id of ["中文", " \t\n ", "A".repeat(512), "😀".repeat(256), "e\u0301"])
    success(historical(id));
  for (const id of ["", "A".repeat(513), "😀".repeat(257), "\0", "\ud800"])
    rejected(historical(id), "invalid_value");
  rejected(mutate(values => { values.seed.originalProfileActivationId = "历史激活"; }), "value_conflict", "E1_SEED");
  rejected(mutate((_values, input) => { input.originHistory.completion.activation.activationId = "different"; }), "value_conflict", "E1_SEED");
  for (const change of [
    (values: Fixture) => { values.seed.migrationId = "old-migration"; },
    (values: Fixture) => { values.seed.layoutActivationId = "other-activation"; },
    (values: Fixture) => { values.seed.auditId = "other-audit"; },
    (values: Fixture) => { values.seed.storageId = "other-storage"; },
    (values: Fixture) => { values.seed.plannedAt = "2026-11-19T07:00:00.000Z"; },
  ]) rejected(mutate(change), "value_conflict", "E1_SEED");
  for (const change of [
    (values: Fixture) => { values.seed.layoutActivationId = "新布局"; },
    (values: Fixture) => { values.seed.storageId = ".invalid"; },
    (values: Fixture) => { values.seed.auditRowid = null; },
    (values: Fixture) => { values.seed.layoutStateRowid = "01"; },
    (values: Fixture) => { values.seed.auditRowid = "9223372036854775808"; },
    (values: Fixture) => { values.seed.layoutStateRowid = "-9223372036854775809"; },
    (values: Fixture) => { values.seed.actor.extra = true; },
  ]) rejected(mutate(change), "invalid_value", "E1_SEED");
  success(mutate(values => { values.seed.auditRowid = "9223372036854775807"; values.seed.layoutStateRowid = "-9223372036854775808"; }));
  rejected(mutate(values => { values.seed.auditRowid = "1"; }, "postgres-retain-database-present"), "invalid_value", "E1_SEED");
});

test("E1-AC08: every local typed edge, source, root role and binding relation is checked", () => {
  const edges: [string, string[]][] = [
    ["seed", ["plan"]], ["seed", ["sourceReady"]], ["original", ["plan"]], ["intent", ["origin", "plan"]],
    ["intent", ["fixedSeedPlan"]], ["rendererInputs", ["seed"]], ["intent", ["origin", "originalPrivateConfig"]],
    ["database", ["original"]], ["rendererInputs", ["original"]], ["rendererInputs", ["database"]],
    ["recipe", ["database", "privateDescriptor"]], ["recipe", ["privateInputs"]],
    ["rootBindings", ["binding", "plan"]], ["rootBindings", ["binding", "intent"]],
    ["intent", ["identity", "memoryFormatContract"]], ["recipe", ["identity", "memoryFormatContract"]],
    ["recipe", ["rendererContract"]], ["intent", ["transitionContract"]], ["intent", ["allowedDeltaContract"]],
  ];
  for (const [slot, keys] of edges) {
    rejected(mutate(values => {
      let edge = values[slot]; for (const key of keys) edge = edge[key]; edge.bytes = "999";
    }), "reference_conflict", "E1_BINDING");
  }
  for (const slot of ["seed", "original", "database", "rendererInputs"])
    rejected(mutate(values => { values[slot].source.databaseInstanceId = "2".repeat(32); }), "value_conflict", "E1_BINDING");
  for (const change of [
    (values: Fixture) => { values.rootBindings.roots.reverse(); },
    (values: Fixture) => { values.rootBindings.parents.reverse(); },
    (values: Fixture) => { values.rootBindings.parents[2].identity.path = "/wrong/migrations"; },
    (values: Fixture) => { values.rootBindings.roots[3].identity.path = "/wrong/skills"; },
    (values: Fixture) => { values.rootBindings.control.identity.path = "/wrong/control"; },
    (values: Fixture) => { values.rootBindings.roots[0].identity.hostIdentityDigest = "0".repeat(64); },
    (values: Fixture) => { values.rootBindings.binding.phase = "verified"; },
    (values: Fixture) => { values.rootBindings.binding.migrationId = "wrong"; },
    (values: Fixture) => { values.rootBindings.binding.layoutActivationId = "wrong"; },
    (values: Fixture) => { values.rootBindings.binding.storageId = "wrong"; },
    (values: Fixture) => { values.rootBindings.binding.targetSource.databaseInstanceId = "3".repeat(32); },
    (values: Fixture) => { values.rendererInputs.settings.port = 4318; },
    (values: Fixture) => { values.database.targetPath = "/other/db"; },
  ]) rejected(mutate(change), "value_conflict", "E1_BINDING");
  for (const change of [
    (values: Fixture) => { values.rootBindings.roots[0].identity.inode = "0"; },
    (values: Fixture) => { values.rootBindings.parents[0].identity.device = "01"; },
    (values: Fixture) => { values.rootBindings.control.identity.device = "18446744073709551616"; },
    (values: Fixture) => { values.rootBindings.control.identity.inode = "1".repeat(2000); },
    (values: Fixture) => { values.rootBindings.roots[0].identity.path = "/target/../target"; },
    (values: Fixture) => { values.rootBindings.binding.window.epoch = 0; },
    (values: Fixture) => { values.rootBindings.binding.window.extra = "secret"; },
  ]) rejected(mutate(change), "invalid_value", "E1_BINDING");
  const retain = vector().input; retain.targetSource.databaseInstanceId = "3".repeat(32);
  rejected(retain, "value_conflict", "E1_BINDING");
  rejected(mutate(values => { values.database.targetPath = values.recipe.database.targetPath = "/other/approved.db"; },
    "sqlite-relocate-sqlite-present"), "semantic_unsupported", "E1_BINDING");
  rejected(mutate(values => {
    values.intent.mode = values.recipe.mode = "initialize-new";
    values.intent.origin = { kind: "new-space", explicitSelection: values.seed.plan, absenceObservation: values.seed.sourceReady };
  }), "semantic_unsupported", "E1_INPUT");
});

// R-E1-REQ-001: R3 Decimal is a canonical decimal string of at most 20 digits,
// including refs whose external objects remain unproven by this finite projection.
const decimalRefPositions: [string, (values: Fixture) => Fixture][] = [
  ["control.profile", values => values.rootBindings.control.profile],
  ["roots.sourceProfile", values => values.rootBindings.roots[0].sourceProfile],
  ["parents.sourceProfile", values => values.rootBindings.parents[0].sourceProfile],
  ["window.predecessor", values => values.rootBindings.binding.window.predecessor],
];
for (const [name, select] of decimalRefPositions) for (const length of [20, 21, 64]) {
  test(`E1-AC02/08 R-E1-REQ-001: ${name}.bytes at ${length} digits`, () => {
    const input = mutate(values => { select(values).bytes = "1".repeat(length); });
    if (length === 20) success(input);
    else rejected(input, "invalid_value", "E1_BINDING");
  });
}
for (const field of ["systemIdentifier", "databaseOid", "schemaOid"]) for (const length of [20, 21]) {
  test(`E1-AC06 R-E1-REQ-001: PostgreSQL ${field} at ${length} digits`, () => {
    const input = mutate((values, input) => {
      values.plan.sourceIdentity[field] = "1".repeat(length);
      const source = { ...values.plan.source, identityDigest: digestJson(values.plan.sourceIdentity) };
      // Preserve the full typed graph so only the Decimal boundary can reject it.
      for (const slot of ["plan", "seed", "original", "database", "rendererInputs"]) values[slot].source = source;
      values.intent.origin.source = values.rootBindings.binding.source = values.rootBindings.binding.targetSource = source;
      input.targetSource = input.originHistory.source = source;
      input.originHistory.completion.sourceIdentityDigest = source.identityDigest;
    }, "postgres-retain-database-present");
    if (length === 20) {
      const output = success(input);
      assert.equal(output.source.identityDigest, digestJson(unpack(input).plan.sourceIdentity));
      assert.deepEqual(output.targetSource, output.source);
    } else rejected(input, "invalid_value", "E1_BINDING");
  });
}

test("E1-AC06/09/10/11: consumers reparse all files, and PG namespaces stay explicit with activation unproven", () => {
  for (const fixture of fixtures.vectors) {
    const { input } = vector(fixture.name), result = success(input), values = unpack(input);
    const intent = parseLayoutIntentValue(values.intent), recipe = parsePublicationRecipeValue(values.recipe);
    assert.deepEqual(checkLayoutPublicationValueJoin({ intent, recipe, bundle: parsePublicationBundleValue(result.bundle) }), result.join);
    const config = JSON.parse(Buffer.from(result.files[0]!.bytesHex, "hex").toString("utf8"));
    const reread = parseConfigValues({ cwd: "/target", env: {}, fileValues: config, configFile: "/target/config.json",
      filePathBase: "/target", defaultDataDir: "/target/state" });
    assert.equal(reread.port, 4317);
    assert.equal(reread.dataDir, config.dataDir);
    assert.equal(config.pgConnectionString ?? null, values.original.effective.pgConnectionString);
    if (fixture.name.startsWith("postgres")) assert.equal(config.postgresSchema, "tenant_one");
    else assert.equal(Object.hasOwn(config, "postgresSchema"), false);
    for (const file of result.files) {
      const bytes = Buffer.from(file.bytesHex, "hex");
      assert.equal(bytes.length, Number(file.artifact.bytes));
      assert.equal(sha256(bytes), file.artifact.sha256);
      assert.equal(bytes.toString("utf8"), canonicalJson(JSON.parse(bytes.toString("utf8"))));
    }
    for (const file of result.files.slice(1)) assert.equal(Buffer.from(file.bytesHex, "hex").toString("utf8").includes("postgresql://"), false);
    assert.deepEqual(result.remaining[7], { check: "v2-startup-activation", status: "unproven" });
  }
  for (const change of [
    (values: Fixture) => { values.database.namespace = "public"; },
    (values: Fixture) => { values.database.connectionString = "postgresql://wrong:secret@localhost/db"; },
    (values: Fixture) => { values.database.locationId = "0".repeat(64); },
    (values: Fixture) => { values.recipe.database.locationId = "0".repeat(64); },
  ]) {
    const error = rejected(mutate(change, "postgres-retain-database-present"), "value_conflict", "E1_BINDING");
    assert.equal(JSON.stringify(error).includes("secret"), false);
  }
});

test("E1-AC01/04: captured inputs require no current environment, cwd, clock or randomness", () => {
  const { input, expected } = vector();
  const priorEnv = process.env;
  let reads = 0;
  const cwd = mock.method(process, "cwd", () => { reads++; throw new Error("cwd touched"); });
  const clock = mock.method(Date, "now", () => { reads++; throw new Error("clock touched"); });
  const random = mock.method(Math, "random", () => { reads++; throw new Error("random touched"); });
  let result;
  try {
    process.env = new Proxy({}, { get() { reads++; throw new Error("env touched"); }, ownKeys() { reads++; throw new Error("env touched"); } });
    result = buildLayoutPublicationFileValues(input);
  } finally { process.env = priorEnv; cwd.mock.restore(); clock.mock.restore(); random.mock.restore(); }
  assert.equal(reads, 0);
  assert.deepEqual(result, { ok: true, value: expected });
});

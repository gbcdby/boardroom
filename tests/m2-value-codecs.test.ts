import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { M2_COLUMN_CONTRACT, M2_FORMAT_REGISTRATION } from "../src/server/identity/m2-value-contracts.ts";
import { parseM2Value, m2ValueDigest, checkM2SnapshotMappingValues, checkM2DetachValues,
  checkM2AuthorityValues } from "../src/server/identity/m2-value-codecs.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const h = (digit = "a") => digit.repeat(64);
const evidence = (artifactId: string, digit = "a") => ({ artifactId, digest: h(digit) });
const artifact = (name: string, digit = "a") => ({ ref: `private/${name}`, sha256: h(digit), bytes: "1" });
const profile = () => ({ preferredHost: null, model: null, instructions: "", defaultRoleRef: null,
  skillSelection: [], toolSelection: [], memorySelection: [], maxConcurrentInstances: 1, legacyCompatibility: null });
function ok<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) assert.fail(JSON.stringify(result)); return result.value;
}
function fail(result: unknown, code: string) { assert.deepEqual(result, { ok: false, error: { code } }); }
function frozen(value: unknown): void { if (value && typeof value === "object") {
  assert.equal(Object.isFrozen(value), true); for (const v of Object.values(value)) frozen(v);
} }

test("PA-S1-01/02: exact registered data and complete column contract", () => {
  assert.equal(M2_FORMAT_REGISTRATION.state, "registered-stage1");
  assert.equal(M2_FORMAT_REGISTRATION.configFormat, 1); assert.equal(M2_FORMAT_REGISTRATION.schemaMigration, 22);
  assert.equal(hash(canonicalJson(M2_FORMAT_REGISTRATION) + "\n"), "3ba13e56bc866baa333b7d218e668ea57227197452d68444b7dcc59392b387f4");
  assert.equal(Buffer.byteLength(canonicalJson(M2_FORMAT_REGISTRATION) + "\n"), 2106);
  assert.equal(M2_FORMAT_REGISTRATION.independentAcceptanceRef.sha256, "7b6f63393a998c98bafecf7b6652f24fba865b0ac3eacc759ef86a27dccf8030");
  assert.equal(hash(canonicalJson(M2_COLUMN_CONTRACT)), M2_FORMAT_REGISTRATION.columnContractValueDigest);
  assert.equal(hash(canonicalJson(M2_COLUMN_CONTRACT) + "\n"), M2_FORMAT_REGISTRATION.columnContractRef.sha256);
  assert.equal(M2_COLUMN_CONTRACT.relations.reduce((n, t) => n + t.columns.length, 0), 138);
  assert.equal(M2_COLUMN_CONTRACT.executionFragments.reduce((n, t) => n + t.columns.length, 0), 8);
  frozen(M2_FORMAT_REGISTRATION); frozen(M2_COLUMN_CONTRACT);
});

test("PA-01/05: strict E1 profile copy, hash and rejection through public value API", () => {
  const input = profile(); const value = ok(parseM2Value({ kind: "profile-content", value: input }));
  assert.deepEqual(value, { kind: "profile-content", value: input }); frozen(value);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(ok(m2ValueDigest({ kind: "profile-content", body: input })).digest, hash(canonicalJson(input)));
  fail(parseM2Value({ kind: "profile-content", value: { ...input, skillSelection: ["invented"] } }), "invalid_value");
  fail(parseM2Value({ kind: "future", value: input }), "unsupported_shape");
  fail(parseM2Value({ kind: "profile-content", value: { ...input, secret: true } }), "invalid_value");
});

const config = () => ({ model: "model", workdir: "/original", tools: ["Read", "Read"], systemPrompt: "prompt", permissionMode: "auto" });
const semantic = (backend: string, value: ReturnType<typeof config>, advancedStrategy: string | null) => hash(JSON.stringify({ backend,
  config: { model: value.model, workdir: value.workdir, tools: value.tools, systemPrompt: value.systemPrompt, permissionMode: value.permissionMode }, advancedStrategy }));
function profileVersion(revision = 2) { const content = profile(); return { ref: { agentId: "agent", profileRevision: revision, contentDigest: hash(canonicalJson(content)) }, content }; }
function scope() { return { sourceIdentityDigest: h(), agentId: "agent", executionBindingId: "execution", projectId: "project",
  groupId: "group", memberId: "member", membershipRevision: 4, permissionMode: "auto", tools: ["Read", "Read"] }; }
function selected() { const existingScope = scope(); return { state: "selected", strategy: "bypassPermissions", basis: {
  profileRef: profileVersion().ref, bindingConfigRevision: 3, backend: "claude-code", ordinaryConfigDigest: hash(canonicalJson({ backend: "claude-code", config: config() })),
  root: { workspaceRef: { projectId: "project", workspaceRevision: 1 }, canonicalRoot: "/root", physicalResourceKey: "dev:ino",
    rootIdentity: { device: "dev", inode: "ino", birthtimeNs: "0" } }, existingScope,
  existingPermissionScopeDigest: hash(canonicalJson(existingScope)), compatibilityBasis: { runtimeRevision: 7, bindingRevision: 8 } },
  origin: { kind: "explicit_compat_request", requestId: "request" } }; }
function bindingVersion(advanced: unknown = { state: "none" }) { const content = { roleRef: null, profileOverrides: {}, currentAdvanced: advanced };
  return { ref: { groupBindingId: "binding", bindingConfigRevision: 3, contentDigest: hash(canonicalJson(content)) },
    agentId: "agent", projectId: "project", groupId: "group", memberId: "member", content }; }
function receipt() { const body = { requestId: "request", planRef: { planId: "plan", digest: h() },
  physicalSourceRef: evidence("physical"), snapshotReceiptRef: evidence("snapshot"),
  captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h("b") }, schemaBeforeDigest: h("c"), schemaAfterDigest: h("d"),
  guardTransition: { protocolBefore: 1, protocolAfter: 2, guardBeforeDigest: h("e"), guardAfterDigest: h("f"),
    schemaBeforeDigest: h("c"), schemaAfterDigest: h("d"), writerFormat: "s2-profile-config/v1", writerFormatDigest: h(), registeredUpgrade: evidence("upgrade") },
  allowedDeltaManifest: evidence("delta"), targetRowsDigest: h(), sourceToTargetManifest: evidence("manifest"), committedAuthority: "profile" };
  return { ref: { activationId: "activation", digest: hash(canonicalJson(body)) }, ...body }; }

test("PA-06/07: current Advanced states, immutable basis digest and binding scope", () => {
  const value = selected(); assert.deepEqual(ok(parseM2Value({ kind: "current-advanced", value })).value, value);
  assert.deepEqual(ok(parseM2Value({ kind: "binding-version", value: bindingVersion(value) })).value, bindingVersion(value));
  for (const [key, replacement] of [["ordinaryConfigDigest", "bad"], ["existingPermissionScopeDigest", h("f")], ["compatibilityBasis", null]] as const) {
    const input = selected(); Reflect.set(input.basis, key, replacement);
    fail(parseM2Value({ kind: "current-advanced", value: input }), key === "ordinaryConfigDigest" ? "invalid_value" : "value_conflict");
  }
  const cross = bindingVersion(selected()); cross.memberId = "other";
  fail(parseM2Value({ kind: "binding-version", value: cross }), "value_conflict");
  const view = { stored: selected(), effectiveStrategy: "bypassPermissions", validity: "effective", blockedReasons: [] };
  ok(parseM2Value({ kind: "current-advanced-view", value: view }));
  fail(parseM2Value({ kind: "current-advanced-view", value: { ...view, validity: "invalidated_by_revision" } }), "value_conflict");
  for (const reason of ["invalidated_by_revision", "migration_reconfirmation_required"]) {
    const stored = { state: "retained_inactive", original: { strategy: "bypassPermissions", runtimeRevision: 7, bindingRevision: 8 },
      captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h() }, reason };
    ok(parseM2Value({ kind: "current-advanced-view", value: { stored, effectiveStrategy: null, validity: reason, blockedReasons: ["retained"] } }));
  }
});

test("PA-14/15: strict source binding and receipt, no self hash or field repair", () => {
  for (const value of [{ contract: "m2-source-binding/r1", kind: "legacy", physicalSourceRef: evidence("physical") },
    { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: evidence("physical"), activation: receipt().ref },
    { contract: "m2-source-binding/r1", kind: "imported", importArtifact: artifact("import"), importValueDigest: h() }]) {
    assert.deepEqual(ok(parseM2Value({ kind: "source-binding", value })).value, value);
    assert.equal(ok(m2ValueDigest({ kind: "source-binding", body: value })).digest, hash(canonicalJson(value)));
  }
  const value = receipt(); assert.deepEqual(ok(parseM2Value({ kind: "activation-receipt", value })).value, value);
  const { ref, ...body } = value;
  assert.equal(ok(m2ValueDigest({ kind: "activation-receipt", body })).digest, ref.digest);
  fail(m2ValueDigest({ kind: "activation-receipt", body: value }), "invalid_value");
  value.guardTransition.schemaAfterDigest = h("f"); fail(parseM2Value({ kind: "activation-receipt", value }), "value_conflict");
});

function snapshot(revision = 2, selection: unknown = { state: "none" }, resolved = "not_selected", effective: string | null = null) {
  const value = { agentId: "agent", groupBindingId: "binding", executionBindingId: "execution", memberId: "member", projectId: "project", groupId: "group",
    backend: "claude-code", config: config(), advancedStrategy: effective, semanticDigest: semantic("claude-code", config(), effective),
    origin: { kind: "profile", profileRef: profileVersion(revision).ref, bindingRef: bindingVersion(selection).ref },
    advancedBasis: { kind: "profile", bindingRef: bindingVersion(selection).ref, currentSelection: selection, resolved }, legacyAlias: null };
  return { ref: { snapshotId: `snapshot-${revision}`, contentDigest: hash(canonicalJson(value)) }, ...value };
}
function mapping(value = snapshot()) { const body = { configSnapshotRef: value.ref, workspaceRef: { projectId: "project", workspaceRevision: 1 },
  originalWorkdir: value.config.workdir, canonicalRoot: "/root", rootIdentity: { device: "dev", inode: "ino", birthtimeNs: "0" },
  physicalResourceKey: "dev:ino", observedAt: "observed", observationOnly: true, requiresRevalidation: true, runReady: false };
  return { ref: { mappingId: "mapping", contentDigest: hash(canonicalJson(body)) }, ...body }; }
function detach() { const old = snapshot(1), map = mapping(old); const body = {
  attachment: { executionBindingId: "execution", groupBindingId: "binding", runtimeId: "runtime" }, profileRef: profileVersion(2).ref,
  bindingRef: bindingVersion().ref, root: { state: "fixed_reference", workspaceRef: map.workspaceRef, mappingRef: map.ref,
    canonicalRoot: map.canonicalRoot, physicalResourceKey: map.physicalResourceKey, rootIdentity: map.rootIdentity,
    observedAt: "root-observed", requiresRevalidation: true, runReady: false },
  currentAdvanced: { stored: { state: "none" }, effectiveStrategy: null, validity: "not_selected", blockedReasons: [] },
  resolution: { state: "complete", backend: "claude-code", config: config(), advancedStrategy: null, semanticDigest: semantic("claude-code", config(), null) },
  requested: { state: "blocked", snapshotRef: old.ref, reasons: ["mapping-unavailable"] }, applied: { state: "mapped", snapshotRef: old.ref, mappingRef: map.ref },
  observedAt: "detach-observed", readOnly: true, runReady: false };
  return { ref: { detachSnapshotId: "detach", contentDigest: hash(canonicalJson(body)) }, ...body }; }
function legacySnapshot() { const configValue = config(), advancedStrategy = "bypassPermissions";
  const digest = semantic("claude-code", configValue, advancedStrategy), versions = { runtimeRevision: 1, bindingRevision: 2 };
  const current = { strategy: "bypassPermissions", runtimeRevision: 4, bindingRevision: 5 };
  const rawJson = JSON.stringify({ backend: "claude-code", config: configValue, versions, advancedStrategy, digest }, null, 2);
  const rawAdvancedJson = JSON.stringify(current);
  const body = { agentId: "agent", groupBindingId: "binding", executionBindingId: "execution", memberId: "member", projectId: "project", groupId: "group",
    backend: "claude-code", config: configValue, advancedStrategy, semanticDigest: digest,
    origin: { kind: "legacy", legacyRef: { authority: "legacy", kind: "applied", sourceId: "execution", runtimeId: "runtime", bindingId: "execution",
      agentId: "agent", digest, versions, configVersion: 1 }, raw: { captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h() },
      rawJson, rawDigest: hash(rawJson), rawAdvancedJson, rawAdvancedDigest: hash(rawAdvancedJson) } },
    advancedBasis: { kind: "legacy", legacy: { originalSelection: current, originalValidity: "invalidated_by_revision",
      mappedValidity: "invalidated_by_revision", equivalenceEvidenceDigest: null } }, legacyAlias: { displayName: "old", hostType: "claude-code" } };
  return { ref: { snapshotId: "legacy-applied", contentDigest: hash(canonicalJson(body)) }, ...body }; }

test("PA-08/09/10/11: immutable snapshots preserve old advanced bytes and exact mapping pair", () => {
  for (const value of [snapshot(), snapshot(2, selected(), "effective", "bypassPermissions"), snapshot(3, selected(), "invalidated_by_revision"), legacySnapshot()]) {
    assert.deepEqual(ok(parseM2Value({ kind: "config-snapshot", value })).value, value);
    const { ref, ...body } = value; assert.equal(ok(m2ValueDigest({ kind: "config-snapshot", body })).digest, ref.contentDigest);
  }
  const snap = snapshot(), map = mapping(snap);
  assert.deepEqual(ok(checkM2SnapshotMappingValues({ snapshot: snap, mapping: map })), {
    snapshotRef: snap.ref, mappingRef: map.ref, workspaceRef: map.workspaceRef, executionBindingId: snap.executionBindingId });
  const old = legacySnapshot(); old.origin.raw.rawDigest = h("f");
  fail(parseM2Value({ kind: "config-snapshot", value: old }), "value_conflict");
  const mapBody = { ...map, originalWorkdir: "/other" }; const { ref, ...body } = mapBody; mapBody.ref = { ...ref, contentDigest: hash(canonicalJson(body)) };
  fail(checkM2SnapshotMappingValues({ snapshot: snap, mapping: mapBody }), "value_conflict");
});

test("PA-12/13: detach fixes P2 current and P1 applied without consulting later heads", () => {
  const value = detach(), old = snapshot(1), map = mapping(old);
  ok(parseM2Value({ kind: "detach-snapshot", value }));
  const input = { detach: value, profile: profileVersion(2), binding: bindingVersion(), requested: { snapshot: old, mapping: null },
    applied: { snapshot: old, mapping: map }, rootSelected: { snapshot: old, mapping: map } };
  const result = ok(checkM2DetachValues(input));
  assert.deepEqual(result, { detachRef: value.ref, attachment: value.attachment, profileRef: value.profileRef, bindingRef: value.bindingRef,
    requested: value.requested, applied: value.applied });
  fail(checkM2DetachValues({ ...input, profile: profileVersion(3) }), "value_conflict");
  fail(checkM2DetachValues({ ...input, requested: { snapshot: old, mapping: map } }), "value_conflict");
  fail(checkM2DetachValues({ ...input, rootSelected: null }), "value_conflict");
});

function capture() { const tables = ["agents", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members",
  "members", "projects", "groups", "group_participants", "agent_legacy_aliases"];
  return { contract: "m2-legacy-capture-body/r1", captureId: "capture", physicalSourceRef: evidence("physical"), snapshotReceiptRef: evidence("snapshot"),
    source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: h("1") }, textEncoding: { backend: "sqlite", name: "UTF-16le" },
    persistedAliases: true, legacySourceDigest: h(), tables: tables.map(name => { const columns = name === "agent_runner_states" ? ["binding_id"]
      : name === "agent_runtime_members" ? ["member_id"] : name === "group_participants" ? ["group_id", "member_id"]
      : name === "agent_legacy_aliases" ? ["display_name", "host_type"] : ["id"];
      return { name, columnContract: artifact(`${name}-columns`), columns: [...columns, "raw"], count: "1", rows: [{ rowid: "9223372036854775807",
        cells: [...columns.map(() => ["text", "6100"]), ["integer", "-9223372036854775808"]] }] }; }) };
}
function history() { const r = receipt(); return { contract: "profile-origin-history-value/r1",
  source: { kind: "sqlite", databaseInstanceId: "1".repeat(32), identityDigest: h("1") }, authorityRow: artifact("authority"),
  activation: r.ref, activationReceipt: artifact("receipt"), completion: { activation: r.ref, takeoverPlan: r.planRef, migrationId: "migration",
    s4PlanDigest: h(), sourceIdentityDigest: h("1"), epochBefore: 7, epochAfter: 8, terminal: { record: evidence("terminal"), sequence: 2 } },
  journalClosure: artifact("closure") }; }
function imported() { const sourceHistory = history(); return { contract: "profile-authority-import-value/r1", sourceHistory,
  preservation: { contract: "profile-preservation-manifest-value/r1", source: sourceHistory.source, snapshotReady: artifact("ready"),
    sourceFormat: { protocolVersion: 2, writerFormat: "s2-profile-config/v1", writerFormatDigest: h(), schemaManifest: artifact("schema"), guardManifest: artifact("guard") },
    tables: ["agent_profiles", "agent_profile_versions", "group_bindings", "group_binding_config_versions", "legacy_config_captures", "config_snapshots",
      "config_detach_snapshots", "config_workspace_mappings", "config_activation_receipts", "config_mutation_receipts"].map(name => ({ name,
      columnContract: artifact(`${name}-columns`), typedRows: artifact(`${name}-rows`), count: "0", rowMultisetDigest: h() })),
    dependencies: { stableIdentities: artifact("identities"), roleVersions: artifact("roles"), executionLinks: artifact("executions"), workspaceReferences: artifact("workspaces"), auditHistory: artifact("audit") } },
  layout: { migrationId: "layout", activationId: "layout-activation", intentArtifact: artifact("intent"), intentValueDigest: h(), transitionContract: artifact("transition"), allowedDeltaContract: artifact("delta"), fixedSeedPlan: artifact("seed") },
  target: { source: { kind: "sqlite", databaseInstanceId: "9".repeat(32), identityDigest: h("9") }, provisioning: artifact("target") },
  authorityProjection: { owner: "profile", activationId: receipt().ref.activationId, sourceBindingRef: "SELF" } }; }
function authorityInputs() { const r = receipt(), sourceHistory = history(), imp = imported(), importSelection = { artifact: artifact("import"), value: imp, valueDigest: hash(canonicalJson(imp)) };
  const legacy = { authority: { singleton: 1, formatVersion: 1, owner: "legacy", activationId: null,
    sourceBinding: { contract: "m2-source-binding/r1", kind: "legacy", physicalSourceRef: evidence("physical") } },
    receipt: null, receiptArtifact: null, sourceHistory: null, importSelection: null };
  const local = { authority: { singleton: 1, formatVersion: 1, owner: "profile", activationId: r.ref.activationId,
    sourceBinding: { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: r.physicalSourceRef, activation: r.ref } },
    receipt: r, receiptArtifact: null, sourceHistory: null, importSelection: null };
  const localHistory = { ...local, receiptArtifact: sourceHistory.activationReceipt, sourceHistory };
  const relocated = { authority: { singleton: 1, formatVersion: 1, owner: "profile", activationId: r.ref.activationId,
    sourceBinding: { contract: "m2-source-binding/r1", kind: "imported", importArtifact: importSelection.artifact, importValueDigest: importSelection.valueDigest } },
    receipt: r, receiptArtifact: sourceHistory.activationReceipt, sourceHistory, importSelection };
  return [legacy, local, localHistory, relocated] as const; }

test("PA-19/21: typed capture histories and exact mutation receipts", () => {
  const value = capture(); assert.deepEqual(ok(parseM2Value({ kind: "legacy-capture", value })).value, value);
  assert.equal(ok(m2ValueDigest({ kind: "legacy-capture", body: value })).digest, hash(canonicalJson(value)));
  const duplicate = capture(); duplicate.tables[0]!.rows.push(duplicate.tables[0]!.rows[0]!); duplicate.tables[0]!.count = "2";
  fail(parseM2Value({ kind: "legacy-capture", value: duplicate }), "value_conflict");
  const overflow = capture(); overflow.tables[0]!.rows[0]!.rowid = "9223372036854775808";
  fail(parseM2Value({ kind: "legacy-capture", value: overflow }), "invalid_value");
  const count = capture(); count.tables[0]!.count = "01"; fail(parseM2Value({ kind: "legacy-capture", value: count }), "invalid_value");
  for (const operation of ["profile.create", "profile.save", "binding.save"]) {
    const mutation = { actorScope: "actor", operation, targetScope: operation === "binding.save" ? { kind: "binding", groupBindingId: "binding" } : { kind: "agent", agentId: "agent" },
      mutationId: "mutation", commandDigest: h(), result: { kind: operation === "binding.save" ? "binding" : "profile",
        saved: { ref: operation === "binding.save" ? bindingVersion().ref : profileVersion(1).ref, mutationId: "mutation", pendingApply: true, missing: [] } }, auditId: "audit" };
    assert.deepEqual(ok(parseM2Value({ kind: "mutation-receipt", value: mutation })).value, mutation);
    mutation.result.saved.mutationId = "other"; fail(parseM2Value({ kind: "mutation-receipt", value: mutation }), "value_conflict");
  }
});

test("PA-S1-03/04/05/06: complete authority joins use real F1 and exact P1 history", () => {
  for (const input of authorityInputs()) {
    const value = ok(checkM2AuthorityValues(input)); frozen(value);
    assert.deepEqual(value, { kind: input.authority.sourceBinding.kind, activation: input.receipt?.ref ?? null, sourceBinding: input.authority.sourceBinding });
    for (const formatVersion of [2, 3, 2147483647]) fail(checkM2AuthorityValues({ ...input, authority: { ...input.authority, formatVersion } }), "unsupported_shape");
    for (const formatVersion of [0, -0, -1, 1.5, 2147483648, Infinity]) fail(checkM2AuthorityValues({ ...input, authority: { ...input.authority, formatVersion } }), "invalid_value");
  }
  const [legacy, local, localHistory, relocated] = authorityInputs();
  fail(checkM2AuthorityValues({ ...legacy, receipt: receipt() }), "value_conflict");
  fail(checkM2AuthorityValues({ ...local, authority: { ...local.authority, activationId: "other" } }), "value_conflict");
  fail(checkM2AuthorityValues({ ...localHistory, receiptArtifact: null }), "value_conflict");
  const differentHistory = history(); differentHistory.journalClosure = artifact("other-history");
  fail(checkM2AuthorityValues({ ...relocated, sourceHistory: differentHistory }), "value_conflict");
  fail(checkM2AuthorityValues({ ...relocated, authority: { ...relocated.authority, sourceBinding: {
    ...relocated.authority.sourceBinding, importValueDigest: relocated.importSelection.artifact.sha256 } } }), "value_conflict");
});

test("PA-02/03: hostile properties never run getters/toJSON or leak exceptions", () => {
  let calls = 0;
  const accessor = Object.defineProperty(profile(), "instructions", { enumerable: true, get() { calls++; throw Error("secret"); } });
  fail(parseM2Value({ kind: "profile-content", value: accessor }), "invalid_value"); assert.equal(calls, 0);
  const json = { ...profile(), toJSON() { calls++; return {}; } }; fail(parseM2Value({ kind: "profile-content", value: json }), "invalid_value"); assert.equal(calls, 0);
  for (const input of [Object.assign(Object.create({ inherited: true }), profile()), Object.assign(profile(), { [Symbol("hidden")]: true }),
    Object.defineProperty(profile(), "hidden", { value: true }), { ...profile(), instructions: undefined }, { ...profile(), maxConcurrentInstances: -0 },
    { ...profile(), maxConcurrentInstances: NaN }, { ...profile(), skillSelection: new Array(1) }, { ...profile(), skillSelection: Object.assign([], { extra: true }) }]) {
    fail(parseM2Value({ kind: "profile-content", value: input }), "invalid_value");
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  fail(parseM2Value(cycle), "invalid_value");
  const error = new Proxy({}, { get() { calls++; throw Error("must not inspect thrown object"); } });
  const proxy = new Proxy(profile(), { ownKeys() { throw error; } });
  fail(parseM2Value({ kind: "profile-content", value: proxy }), "invalid_value"); assert.equal(calls, 0);
  let ownKeys = 0;
  const changingKeys = new Proxy(profile(), { ownKeys(target) { ownKeys++; return ownKeys === 1 ? Reflect.ownKeys(target) : [...Reflect.ownKeys(target), "extra"]; } });
  ok(parseM2Value({ kind: "profile-content", value: changingKeys })); assert.equal(ownKeys, 1);
  const shared: never[] = []; const input = { ...profile(), skillSelection: shared, toolSelection: shared, memorySelection: shared };
  const parsed = ok(parseM2Value({ kind: "profile-content", value: input }));
  assert.equal(Object.isFrozen(shared), false); assert.equal(Object.isFrozen(input), false);
  assert.equal(parsed.kind, "profile-content"); if (parsed.kind === "profile-content") assert.notEqual(parsed.value.skillSelection, parsed.value.toolSelection);
  for (const instructions of ["\ud800", "\udfff", "line\n\t\u0000", "𐐀汉字"]) ok(parseM2Value({ kind: "profile-content", value: { ...profile(), instructions } }));
});

test("PA-04: exact byte/node/depth budgets and bounded nested raw JSON", () => {
  const empty = { kind: "profile-content", value: profile() };
  const overhead = Buffer.byteLength(JSON.stringify(empty));
  ok(parseM2Value({ ...empty, value: { ...empty.value, instructions: "x".repeat(16_777_216 - overhead) } }));
  fail(parseM2Value({ ...empty, value: { ...empty.value, instructions: "x".repeat(16_777_217 - overhead) } }), "budget_exceeded");
  fail(parseM2Value({ ...empty, value: { ...empty.value, instructions: "\u0000".repeat(3_000_000) } }), "budget_exceeded");
  const base = { kind: "current-advanced-view", value: { stored: { state: "none" }, effectiveStrategy: null, validity: "not_selected", blockedReasons: [] as string[] } };
  const nodes = (v: unknown): number => 1 + (v !== null && typeof v === "object" ? Object.values(v).reduce<number>((n, child) => n + nodes(child), 0) : 0);
  const room = 250_000 - nodes(base);
  ok(parseM2Value({ ...base, value: { ...base.value, blockedReasons: Array.from({ length: room }, () => "") } }));
  fail(parseM2Value({ ...base, value: { ...base.value, blockedReasons: Array.from({ length: room + 1 }, () => "") } }), "budget_exceeded");
  let nested: unknown = null; for (let i = 0; i < 65; i++) nested = { next: nested };
  fail(parseM2Value(nested), "budget_exceeded");
  const raw = legacySnapshot(); raw.origin.raw.rawJson = "[".repeat(100) + "0" + "]".repeat(100);
  raw.origin.raw.rawDigest = hash(raw.origin.raw.rawJson);
  fail(parseM2Value({ kind: "config-snapshot", value: raw }), "budget_exceeded");
});

test("PA-01/14/24: no unknown discriminators, incomplete envelopes or caller capabilities", () => {
  for (const [kind, value] of [["current-advanced", { state: "future" }], ["source-binding", { contract: "future", kind: "legacy", physicalSourceRef: evidence("physical") }],
    ["config-snapshot", { ...snapshot(), origin: { kind: "future" } }], ["mutation-receipt", { operation: "future" }]] as const)
    fail(parseM2Value({ kind, value }), "unsupported_shape");
  for (const input of [{ kind: "profile-content" }, { kind: "profile-content", value: profile(), budget: 999 },
    { kind: "profile-content", value: profile(), registry: M2_FORMAT_REGISTRATION }, { kind: "profile-content", value: profile(), SourceLock: {} }])
    fail(parseM2Value(input), "invalid_value");
  fail(m2ValueDigest({ kind: "json", body: {} }), "unsupported_shape");
  const body = { ...snapshot() }; fail(m2ValueDigest({ kind: "config-snapshot", body }), "invalid_value");
});


test("PA-S1-08: a data-only disabled constant copy rejects all complete authority variants", async () => {
  const contractsUrl = new URL("../src/server/identity/m2-value-contracts.ts", import.meta.url);
  const codecsUrl = new URL("../src/server/identity/m2-value-codecs.ts", import.meta.url);
  const contracts = await readFile(contractsUrl, "utf8"), codecs = await readFile(codecsUrl, "utf8");
  const marker = "export const M2_FORMAT_REGISTRATION:";
  const prefix = contracts.slice(0, contracts.indexOf(marker)); assert.ok(prefix.endsWith("resolver.\n"));
  const columns = { ...M2_COLUMN_CONTRACT, registration: { schemaMigration: null, configFormat: null } };
  const disabledSource = prefix + "export const M2_FORMAT_REGISTRATION = freeze(" + JSON.stringify({ contract: "m2-value-format-registration/r1",
    state: "unregistered", schemaMigration: null, configFormat: null }) + ");\nexport const M2_COLUMN_CONTRACT = freeze(" + JSON.stringify(columns) + ");\n";
  assert.equal(disabledSource.slice(0, prefix.length), prefix);
  const url = (source: string) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
  const contractData = url(disabledSource);
  const translated = codecs.replace(/from "([^"\n]+)"/g, (all, specifier: string) => {
    const resolved = specifier === "./m2-value-contracts.ts" ? contractData : specifier.startsWith(".")
      ? new URL(specifier, codecsUrl).href : specifier.startsWith("node:") ? specifier : import.meta.resolve(specifier);
    return `from ${JSON.stringify(resolved)}`;
  });
  // Import-location substitution only; all codec logic remains the exact same source body.
  assert.equal(translated.replace(/from "([^"\n]+)"/g, 'from "MODULE"'), codecs.replace(/from "([^"\n]+)"/g, 'from "MODULE"'));
  const disabled = await import(url(translated)) as typeof import("../src/server/identity/m2-value-codecs.ts");
  for (const input of authorityInputs()) {
    fail(disabled.checkM2AuthorityValues(input), "format_unregistered");
    ok(disabled.parseM2Value({ kind: "source-binding", value: input.authority.sourceBinding }));
    ok(checkM2AuthorityValues(input));
  }
});

test("PA-S1-12: registered pure call paths perform no I/O, clock, environment or randomness", () => {
  const calls = [
    { name: "parseM2Value", input: { kind: "profile-content", value: profile() } },
    { name: "parseM2Value", input: { kind: "config-snapshot", value: legacySnapshot() } },
    { name: "parseM2Value", input: { kind: "legacy-capture", value: capture() } },
    { name: "m2ValueDigest", input: { kind: "profile-content", body: profile() } },
    { name: "checkM2SnapshotMappingValues", input: { snapshot: snapshot(), mapping: mapping() } },
    ...authorityInputs().map(input => ({ name: "checkM2AuthorityValues", input })),
    { name: "checkM2DetachValues", input: { detach: detach(), profile: profileVersion(), binding: bindingVersion(),
      requested: { snapshot: snapshot(1), mapping: null }, applied: { snapshot: snapshot(1), mapping: mapping(snapshot(1)) },
      rootSelected: { snapshot: snapshot(1), mapping: mapping(snapshot(1)) } } },
  ];
  const script = `
    import fs from 'node:fs'; import fsp from 'node:fs/promises'; import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import * as values from ${JSON.stringify(new URL("../src/server/identity/m2-value-codecs.ts", import.meta.url).href)};
    const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
    let calls = 0; const undo = [];
    const block = () => { calls++; throw Error('blocked effect'); };
    const patch = (object, key) => { const old = object[key]; object[key] = block; undo.push(() => object[key] = old); };
    for (const key of ['access','realpath','stat','readFile','writeFile','open','unlink','mkdir','rename','readFileSync','writeFileSync','openSync','statSync'])
      if (typeof fs[key] === 'function') patch(fs, key);
    for (const key of ['access','realpath','stat','readFile','writeFile','open','unlink','mkdir','rename']) patch(fsp, key);
    for (const key of ['randomUUID','randomBytes','randomFill','randomFillSync','randomInt']) patch(crypto,key);
    patch(Date, 'now'); patch(Math, 'random');
    const oldEnv = process.env; process.env = new Proxy({}, { get:block, ownKeys:block, getOwnPropertyDescriptor:block });
    let good = true;
    try { syncBuiltinESMExports(); for (const c of cases) if (values[c.name](c.input).ok !== true) good = false; }
    finally { process.env = oldEnv; for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); }
    if (calls !== 0 || !good) throw Error('pure call boundary failed: ' + calls + '/' + good);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify(calls), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("PA-19: native text/blob and nonfinite real bits survive alternative tuple validation", () => {
  for (const raw of [["text", "ff00"], ["blob", "00ff"], ["real64be", "7ff8000000000001"], ["text", ""], ["blob", ""], ["null"]]) {
    const input = capture(); input.tables[0]!.rows[0]!.cells[1] = raw;
    assert.deepEqual(ok(parseM2Value({ kind: "legacy-capture", value: input })).value, input);
  }
});

test("PA-01/14: all thirteen public kinds and ten exact digest bodies", () => {
  const m = { actorScope: "actor", operation: "profile.save", targetScope: { kind: "agent", agentId: "agent" }, mutationId: "mutation", commandDigest: h(),
    result: { kind: "profile", saved: { ref: profileVersion().ref, mutationId: "mutation", pendingApply: true, missing: [] } }, auditId: "audit" };
  const values = { "profile-content": profile(), "binding-content": bindingVersion().content, "profile-version": profileVersion(), "binding-version": bindingVersion(),
    "current-advanced": { state: "none" }, "current-advanced-view": detach().currentAdvanced, "config-snapshot": snapshot(), "workspace-mapping": mapping(),
    "detach-snapshot": detach(), "source-binding": authorityInputs()[0].authority.sourceBinding, "activation-receipt": receipt(), "legacy-capture": capture(), "mutation-receipt": m };
  for (const [kind, value] of Object.entries(values)) {
    const result = ok(parseM2Value({ kind, value })); assert.equal(result.kind, kind); assert.deepEqual(result.value, value);
    fail(parseM2Value({ kind, value: { ...value, unexpected: true } }), "invalid_value");
  }
  const withoutRef = <T extends { ref: unknown }>(value: T) => { const { ref: _, ...body } = value; return body; };
  const bodies = { "profile-content": profile(), "binding-content": bindingVersion().content, "existing-scope": scope(),
    "ordinary-config": { backend: "claude-code", config: config() }, "config-snapshot": withoutRef(snapshot()), "workspace-mapping": withoutRef(mapping()),
    "detach-snapshot": withoutRef(detach()), "activation-receipt": withoutRef(receipt()), "legacy-capture": capture(), "source-binding": authorityInputs()[0].authority.sourceBinding };
  for (const [kind, body] of Object.entries(bodies)) {
    const result = ok(m2ValueDigest({ kind, body })); assert.equal(result.digest, hash(canonicalJson(body)));
    assert.equal(result.canonicalDomain, kind === "source-binding" ? "storage-maintenance-utf16/v1" : "m2-r3-codepoint/v1");
    assert.equal(result.algorithm, "sha256");
  }
});

test("PA-06/07/09: legacy equivalence keeps exact counters and raw duplicate keys", () => {
  const value = selected(), legacy = legacySnapshot();
  const equivalent = { ...value, basis: { ...value.basis, compatibilityBasis: legacy.origin.legacyRef.versions },
    origin: { kind: "legacy_equivalence", captureRef: legacy.origin.raw.captureRef, legacyRef: legacy.origin.legacyRef } };
  ok(parseM2Value({ kind: "current-advanced", value: equivalent }));
  fail(parseM2Value({ kind: "current-advanced", value: { ...equivalent, basis: { ...equivalent.basis, compatibilityBasis: { runtimeRevision: 1, bindingRevision: 3 } } } }), "value_conflict");
  const raw = legacySnapshot(); raw.origin.raw.rawJson = raw.origin.raw.rawJson.replace("{", '{"backend":"dsh",');
  raw.origin.raw.rawDigest = hash(raw.origin.raw.rawJson); const { ref, ...body } = raw; raw.ref = { ...ref, contentDigest: hash(canonicalJson(body)) };
  const parsed = ok(parseM2Value({ kind: "config-snapshot", value: raw })); assert.deepEqual(parsed.value, raw);
  const unsupported = legacySnapshot(); unsupported.origin.legacyRef.configVersion = 2;
  fail(parseM2Value({ kind: "config-snapshot", value: unsupported }), "unsupported_shape");
});

test("PA-12/13: missing roots and incomplete configuration stay readonly; preview is root-only", () => {
  const original = detach(), { ref, ...body } = original;
  const partial = { ...body, root: { state: "missing", workspaceRef: null, reasons: ["workspace-missing"], runReady: false },
    resolution: { state: "incomplete", backend: null, partialConfig: { workdir: "", model: null }, reasons: ["backend-missing"] } };
  const detached = { ref: { ...ref, contentDigest: hash(canonicalJson(partial)) }, ...partial }, old = snapshot(1), map = mapping(old);
  ok(checkM2DetachValues({ detach: detached, profile: profileVersion(), binding: bindingVersion(),
    requested: { snapshot: old, mapping: null }, applied: { snapshot: old, mapping: map }, rootSelected: null }));
  fail(parseM2Value({ kind: "detach-snapshot", value: { ...detached, resolution: { ...partial.resolution, partialConfig: { model: undefined } } } }), "invalid_value");
  const rootSnap = snapshot(); const { ref: previewRef, ...previewBody } = rootSnap;
  const previewValue = { ...previewBody, executionBindingId: null };
  const preview = { ref: { ...previewRef, contentDigest: hash(canonicalJson(previewValue)) }, ...previewValue };
  const { ref: mapRef, ...mapBody } = mapping(); const previewMapBody = { ...mapBody, configSnapshotRef: preview.ref };
  const previewMap = { ref: { ...mapRef, contentDigest: hash(canonicalJson(previewMapBody)) }, ...previewMapBody };
  const rootBody = { ...body, root: { ...body.root, mappingRef: previewMap.ref } };
  const rootDetach = { ref: { ...ref, contentDigest: hash(canonicalJson(rootBody)) }, ...rootBody };
  ok(checkM2DetachValues({ detach: rootDetach, profile: profileVersion(), binding: bindingVersion(),
    requested: { snapshot: old, mapping: null }, applied: { snapshot: old, mapping: map }, rootSelected: { snapshot: preview, mapping: previewMap } }));
  const badBody = { ...rootBody, requested: { state: "blocked", snapshotRef: preview.ref, reasons: ["preview"] } };
  fail(checkM2DetachValues({ detach: { ref: { ...ref, contentDigest: hash(canonicalJson(badBody)) }, ...badBody }, profile: profileVersion(), binding: bindingVersion(),
    requested: { snapshot: preview, mapping: null }, applied: { snapshot: old, mapping: map }, rootSelected: { snapshot: preview, mapping: previewMap } }), "value_conflict");
});

test("PA-04/16/19: whole-call and original P1 budgets remain closed", () => {
  const local = authorityInputs()[2];
  fail(checkM2AuthorityValues({ ...local, sourceHistory: { ...local.sourceHistory, extra: "x".repeat(1_048_576) } }), "budget_exceeded");
  fail(checkM2AuthorityValues({ ...local, sourceHistory: { ...local.sourceHistory, extra: "x".repeat(8_500_000) },
    importSelection: { value: { extra: "y".repeat(8_500_000) }, artifact: artifact("fake"), valueDigest: h() } }), "budget_exceeded");
  const large = capture(); large.tables[0]!.rows[0]!.cells[1] = ["text", "ff".repeat(600_000)];
  ok(parseM2Value({ kind: "legacy-capture", value: large }));
  const pg = capture(); pg.source.kind = "postgres"; pg.textEncoding.backend = "postgres";
  fail(parseM2Value({ kind: "legacy-capture", value: pg }), "value_conflict");
  for (const t of pg.tables) for (const row of t.rows) Reflect.set(row, "rowid", null);
  ok(parseM2Value({ kind: "legacy-capture", value: pg }));
});

test("PA-04: decoded JSON root is below its string leaf at the exact depth boundary", () => {
  const check = (levels: number) => { const value = legacySnapshot(); value.origin.raw.rawJson = "[".repeat(levels) + "0" + "]".repeat(levels);
    value.origin.raw.rawDigest = hash(value.origin.raw.rawJson); return parseM2Value({ kind: "config-snapshot", value }); };
  fail(check(59), "value_conflict"); // Parsed scalar depth 64: budget permits it, legacy shape still rejects arrays.
  fail(check(60), "budget_exceeded"); // Parsed scalar depth 65: rejected before JSON.parse.
});

function isolationCalls() {
  return [
    { name: "parseM2Value", input: { kind: "profile-content", value: profile() } },
    { name: "parseM2Value", input: { kind: "config-snapshot", value: snapshot() } },
    { name: "parseM2Value", input: { kind: "config-snapshot", value: legacySnapshot() } },
    { name: "m2ValueDigest", input: { kind: "profile-content", body: profile() } },
    { name: "checkM2SnapshotMappingValues", input: { snapshot: snapshot(), mapping: mapping() } },
    { name: "checkM2DetachValues", input: { detach: detach(), profile: profileVersion(), binding: bindingVersion(),
      requested: { snapshot: snapshot(1), mapping: null }, applied: { snapshot: snapshot(1), mapping: mapping(snapshot(1)) },
      rootSelected: { snapshot: snapshot(1), mapping: mapping(snapshot(1)) } } },
    ...authorityInputs().map(input => ({ name: "checkM2AuthorityValues", input })),
  ];
}
const isolationUrl = new URL("../src/server/identity/m2-value-codecs.ts", import.meta.url).href;
function isolationProcess(script: string, input: unknown): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("STD003: environment data Proxy cannot pollute checked prototypes after the final descriptor", () => {
  isolationProcess(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import * as values from ${JSON.stringify(isolationUrl)};
    const cases=JSON.parse(fs.readFileSync(0,'utf8'));
    const original=Object.getOwnPropertyDescriptor(Array.prototype,Symbol.unscopables);
    for(const c of cases) {
      const clean=values[c.name](c.input);assert.equal(clean.ok,true,c.name+' clean');
      const transparent=new Proxy(original.value,{});
      let control;
      try {Object.defineProperty(Array.prototype,Symbol.unscopables,{...original,value:transparent});control=values[c.name](c.input);}
      finally {Object.defineProperty(Array.prototype,Symbol.unscopables,original);}
      assert.deepEqual(control,clean,c.name+' transparent environment Proxy remains supported');
      for(const timing of [1,2,3]) for(const target of [Object.prototype,Array.prototype]) {
        let sweeps=0,hooks=0,actual;
        const proxy=new Proxy(original.value,{
          ownKeys(t){sweeps++;return Reflect.ownKeys(t)},
          getOwnPropertyDescriptor(t,key){const d=Reflect.getOwnPropertyDescriptor(t,key);
            if(sweeps===timing&&key==='values')Object.defineProperty(target,'toJSON',{
              __proto__:null,configurable:true,get(){hooks++;return ()=>({changed:true})}});
            return d;}
        });
        try {Object.defineProperty(Array.prototype,Symbol.unscopables,{...original,value:proxy});actual=values[c.name](c.input);}
        finally {delete target.toJSON;Object.defineProperty(Array.prototype,Symbol.unscopables,original);}
        assert.equal(hooks,0,c.name+'/'+timing+' inherited getter');
        assert.deepEqual(actual,{ok:false,error:{code:'invalid_value'}},c.name+'/'+timing);
      }
    }
  `, [{ name: "parseM2Value", input: { kind: "config-snapshot", value: legacySnapshot() } }, ...isolationCalls()]);
});

test("STD001 ISO-01: exact inherited field and C-SEM probes never invoke hooks or fill missing own fields", () => {
  isolationProcess(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import {parseM2Value} from ${JSON.stringify(isolationUrl)};
    const [profile,snapshot]=JSON.parse(fs.readFileSync(0,'utf8'));
    assert.equal(parseM2Value({kind:'config-snapshot',value:snapshot}).ok,true);
    for(const variant of ['instructions-data','instructions-getter','snapshot-toJSON']) {
      const key=variant==='snapshot-toJSON'?'toJSON':'instructions';
      const input=variant==='snapshot-toJSON'?{kind:'config-snapshot',value:snapshot}:{kind:'profile-content',value:{...profile}};
      if(key==='instructions')delete input.value.instructions;
      let hookCalls=0,trapCalls=0,actual;
      const proxy=new Proxy(input,{ownKeys(target){trapCalls++;
        Object.defineProperty(Object.prototype,key,variant==='instructions-data'
          ?{__proto__:null,configurable:true,writable:true,value:'inherited-instructions'}
          :{__proto__:null,configurable:true,get(){hookCalls++;return key==='toJSON'?function(){return {replaced:true}}:'inherited-instructions'}});
        return Reflect.ownKeys(target);
      }});
      try {actual=parseM2Value(proxy)} finally {delete Object.prototype[key]}
      assert.deepEqual(actual,{ok:false,error:{code:'invalid_value'}},variant);
      assert.equal(hookCalls,0,variant+' must not execute inherited getter');assert.equal(trapCalls,1);
    }
  `, [profile(), snapshot()]);
});

test("STD001 ISO-02/05/06: every value entry rejects ambient pollution before consuming E1/P1 and accepts clean proxies", () => {
  isolationProcess(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import * as values from ${JSON.stringify(isolationUrl)};
    const cases=JSON.parse(fs.readFileSync(0,'utf8'));
    for(const c of cases) {
      const clean=values[c.name](c.input);assert.equal(clean.ok,true,c.name+' clean fixture');
      const nullCopy=value=>value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(nullCopy):
        Object.assign(Object.create(null),Object.fromEntries(Object.entries(value).map(([k,v])=>[k,nullCopy(v)])));
      assert.deepEqual(values[c.name](nullCopy(c.input)),clean,c.name+' null-prototype inputs');
      let cleanTraps=0;
      assert.deepEqual(values[c.name](new Proxy(c.input,{ownKeys(t){cleanTraps++;return Reflect.ownKeys(t)}})),clean);
      assert.equal(cleanTraps,1,c.name+' clean single key snapshot');
      for(const timing of ['before-call','getPrototypeOf','ownKeys','getOwnPropertyDescriptor']) {
        let hooks=0,traps=0,actual;
        const install=()=>Object.defineProperty(Object.prototype,'toJSON',{__proto__:null,configurable:true,get(){hooks++;return ()=>({replaced:true})}});
        const handler={};
        if(timing==='before-call')handler.ownKeys=t=>{traps++;return Reflect.ownKeys(t)};
        else handler[timing]=(...args)=>{traps++;install();return Reflect[timing](...args)};
        const input=new Proxy(c.input,handler);
        try{if(timing==='before-call')install();actual=values[c.name](input)}finally{delete Object.prototype.toJSON}
        assert.deepEqual(actual,{ok:false,error:{code:'invalid_value'}},c.name+'/'+timing);
        assert.equal(hooks,0,c.name+'/'+timing+' getter');
        if(timing==='before-call')assert.equal(traps,0,c.name+' must reject before reflecting input');
      }
    }
  `, isolationCalls());
});

test("STD001 ISO-03: pollution before module evaluation is never adopted as a trusted baseline", () => {
  for (const variant of ["instructions-data", "instructions-getter", "toJSON-getter"]) isolationProcess(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    const cases=JSON.parse(fs.readFileSync(0,'utf8')),variant=${JSON.stringify(variant)};
    const key=variant==='toJSON-getter'?'toJSON':'instructions';let hooks=0,results,loadHooks;
    Object.defineProperty(Object.prototype,key,variant==='instructions-data'
      ?{__proto__:null,configurable:true,writable:true,value:'preloaded-inherited'}
      :{__proto__:null,configurable:true,get(){hooks++;return key==='toJSON'?()=>({replaced:true}):'preloaded-inherited'}});
    try {
      const values=await import(${JSON.stringify(isolationUrl)});loadHooks=hooks;
      results=cases.map(c=>values[c.name](c.input));
    } finally {delete Object.prototype[key]}
    assert.equal(loadHooks,0,variant+' module evaluation must not invoke this hook');
    assert.equal(hooks,0,variant+' calls must not invoke this hook');
    for(const result of results)assert.deepEqual(result,{ok:false,error:{code:'invalid_value'}});
  `, isolationCalls());
});

test("STD001 ISO-04: descriptor inheritance and array index setters cannot run during the own-data copy", () => {
  const withTools = { ...profile(), legacyCompatibility: { tools: ["Read"], permissionMode: "auto" } };
  isolationProcess(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import {parseM2Value} from ${JSON.stringify(isolationUrl)};
    const fixture=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(parseM2Value({kind:'profile-content',value:fixture}).ok,true);
    for(const variant of ['descriptor-value-data','descriptor-value-getter','descriptor-get','descriptor-set','array-index']) {
      const value={...fixture};let hooks=0,ownGetter=0,actual;
      if(variant.startsWith('descriptor-value'))Object.defineProperty(value,'instructions',{
        __proto__:null,configurable:true,enumerable:true,get(){ownGetter++;return ''}});
      const key=variant.startsWith('descriptor-value')?'value':variant==='array-index'?'0':variant.slice('descriptor-'.length);
      const target=variant==='array-index'?Array.prototype:Object.prototype;
      const input=new Proxy({kind:'profile-content',value},{ownKeys(t){
        const descriptor=variant==='descriptor-value-data'?{__proto__:null,configurable:true,value:''}
          :variant==='array-index'?{__proto__:null,configurable:true,set(v){hooks++;Object.defineProperty(this,'0',{__proto__:null,value:v,writable:true,enumerable:true,configurable:true})}}
          :{__proto__:null,configurable:true,get(){hooks++;return variant==='descriptor-value-getter'?'':undefined}};
        Object.defineProperty(target,key,descriptor);return Reflect.ownKeys(t);
      }});
      try{actual=parseM2Value(input)}finally{delete target[key]}
      assert.equal(hooks,0,variant+' inherited hook');assert.equal(ownGetter,0,variant+' input getter');
      assert.deepEqual(actual,{ok:false,error:{code:'invalid_value'}},variant);
    }
  `, withTools);
});

test("STD001 ISO-06: fixed C-SEM bytes retain string escapes, duplicate tools, nulls and field order", () => {
  for (const backend of ["claude-code", "codex-cli", "dsh"]) for (const tools of [null, ["Read", "Read", "\ud800\n\r\t\"\\", "😀"]]) {
    const value = { ...snapshot(), backend,
      config: { model: "m\udfff", workdir: "/工作\r\n", tools, systemPrompt: "\b\f\u0000\"\\😀", permissionMode: "auto" } };
    value.semanticDigest = hash(JSON.stringify({ backend, config: value.config, advancedStrategy: null }));
    const { ref, ...body } = value; value.ref = { ...ref, contentDigest: hash(canonicalJson(body)) };
    assert.deepEqual(ok(parseM2Value({ kind: "config-snapshot", value })).value, value);
  }
});

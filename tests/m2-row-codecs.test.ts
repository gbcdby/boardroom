import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { encodeM2RowValue, decodeM2RowValue } from "../src/server/identity/m2-row-codecs.ts";
import { M2_COLUMN_CONTRACT, M2_FORMAT_REGISTRATION } from "../src/server/identity/m2-value-contracts.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";

const text = (value: string) => ({ kind: "text" as const, value });
const integer = (value: number) => ({ kind: "integer" as const, decimal: String(value) });
const nil = { kind: "null" as const };
const head = { agentId: "agent", currentRevision: 2, legacyRuntimeId: null, compatRuntimeRevision: null };
const headProjection = { contract: "m2-row-projection/r1", table: "agent_profiles", cells: {
  agent_id: text("agent"), current_revision: integer(2), legacy_runtime_id: nil, compat_runtime_revision: nil,
} };
function success<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error("expected successful result"); return result.value;
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}

test("PA-17 R01 complete row roundtrip preserves explicit nulls and fixed deferred head reference", () => {
  const encoded = encodeM2RowValue({ table: "agent_profiles", value: head });
  assert.deepEqual(success(encoded), headProjection); frozen(encoded);
  assert.equal(Object.isFrozen(head), false);
  const decoded = success(decodeM2RowValue(headProjection)); frozen(decoded);
  assert.deepEqual(decoded.value, head); assert.deepEqual(decoded.projection, headProjection);
  assert.equal(decoded.projectionDigest, createHash("sha256").update(canonicalJson(headProjection)).digest("hex"));
  assert.deepEqual(decoded.foreignKeys, [
    { constraintId: "fk:agent_profiles:agent_id->agents:id", targetTable: "agents", targetColumns: ["id"], key: [text("agent")], onDelete: "RESTRICT", deferrable: false },
    { constraintId: "fk:agent_profiles:agent_id,current_revision->agent_profile_versions:agent_id,revision", targetTable: "agent_profile_versions", targetColumns: ["agent_id", "revision"], key: [text("agent"), integer(2)], onDelete: "NO ACTION", deferrable: true },
  ]);
  assert.deepEqual(decoded.artifactRefs, []);
  assert(decoded.remainingSourceChecks.includes("fk_existence"));
});

function rejected(result: unknown, code: string): void { assert.deepEqual(result, { ok: false, error: { code } }); frozen(result); }
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const h = (digit = "a") => digit.repeat(64);
const evidence = (artifactId: string) => ({ artifactId, digest: h() });
const artifact = (name: string) => ({ ref: `private/${name}`, sha256: h("b"), bytes: "1" });
const profileContent = () => ({ preferredHost: null, model: null, instructions: "原文\r\n\ud800", defaultRoleRef: null,
  skillSelection: [], toolSelection: [], memorySelection: [], maxConcurrentInstances: 1, legacyCompatibility: null });
function profileVersion(revision = 2) { const content = profileContent(); return { ref: { agentId: "agent", profileRevision: revision, contentDigest: hash(content) }, content }; }
function bindingContent(advanced: unknown = { state: "none" }) { return { roleRef: null, profileOverrides: {}, currentAdvanced: advanced }; }
function bindingRow(advanced: unknown = { state: "none" }) {
  const content = bindingContent(advanced);
  return { ref: { groupBindingId: "binding", bindingConfigRevision: 3, contentDigest: hash(content) }, content, compatibility: null };
}
const config = () => ({ model: "model", workdir: "/original", tools: ["Read", "Read"], systemPrompt: "prompt", permissionMode: "auto" });
function selected() {
  const existingScope = { sourceIdentityDigest: h(), agentId: "agent", executionBindingId: "execution", projectId: "project", groupId: "group",
    memberId: "member", membershipRevision: 4, permissionMode: "auto", tools: ["Read", "Read"] };
  return { state: "selected", strategy: "bypassPermissions", basis: { profileRef: profileVersion().ref, bindingConfigRevision: 3,
    backend: "claude-code", ordinaryConfigDigest: hash({ backend: "claude-code", config: config() }),
    root: { workspaceRef: { projectId: "project", workspaceRevision: 1 }, canonicalRoot: "/root", physicalResourceKey: "device:inode",
      rootIdentity: { device: "device", inode: "inode", birthtimeNs: "0" } }, existingScope, existingPermissionScopeDigest: hash(existingScope),
    compatibilityBasis: { runtimeRevision: 7, bindingRevision: 8 } }, origin: { kind: "explicit_compat_request", requestId: "request" } };
}
const semantic = (strategy: string | null = null) => hash(JSON.stringify({ backend: "claude-code", config: config(), advancedStrategy: strategy }));
function snapshot(revision = 2) {
  const body = { agentId: "agent", groupBindingId: "binding", executionBindingId: "execution", memberId: "member", projectId: "project", groupId: "group",
    backend: "claude-code", config: config(), advancedStrategy: null, semanticDigest: semantic(),
    origin: { kind: "profile", profileRef: profileVersion(revision).ref, bindingRef: bindingRow().ref },
    advancedBasis: { kind: "profile", bindingRef: bindingRow().ref, currentSelection: { state: "none" }, resolved: "not_selected" }, legacyAlias: null };
  return { ref: { snapshotId: `snapshot-${revision}`, contentDigest: hash(body) }, ...body };
}
function legacySnapshot(kind = "applied") {
  const versions = { runtimeRevision: 1, bindingRevision: 2 }, current = { strategy: "bypassPermissions", runtimeRevision: 4, bindingRevision: 5 };
  const advancedStrategy = kind === "effective" ? null : "bypassPermissions";
  const rawJson = kind === "effective" ? null : JSON.stringify({ backend: "claude-code", config: config(), versions, advancedStrategy, digest: semantic(advancedStrategy) }, null, 2).replaceAll("\n", "\r\n");
  const rawAdvancedJson = JSON.stringify(current);
  const body = { agentId: "agent", groupBindingId: "binding", executionBindingId: "execution", memberId: "member", projectId: "project", groupId: "group",
    backend: "claude-code", config: config(), advancedStrategy, semanticDigest: semantic(advancedStrategy),
    origin: { kind: "legacy", legacyRef: { authority: "legacy", kind, sourceId: "execution", runtimeId: "runtime", bindingId: "execution",
      agentId: "agent", digest: semantic(advancedStrategy), versions, configVersion: 1 },
      raw: { captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h("b") }, rawJson, rawDigest: rawJson === null ? null : hash(rawJson), rawAdvancedJson, rawAdvancedDigest: hash(rawAdvancedJson) } },
    advancedBasis: { kind: "legacy", legacy: { originalSelection: current, originalValidity: "invalidated_by_revision", mappedValidity: "invalidated_by_revision", equivalenceEvidenceDigest: null } },
    legacyAlias: { displayName: "old name", hostType: "claude-code" } };
  return { ref: { snapshotId: `legacy-${kind}`, contentDigest: hash(body) }, ...body };
}
function mapping(value = snapshot(1)) {
  const body = { configSnapshotRef: value.ref, workspaceRef: { projectId: "project", workspaceRevision: 1 }, originalWorkdir: value.config.workdir,
    canonicalRoot: "/root", rootIdentity: { device: "device", inode: "inode", birthtimeNs: "0" }, physicalResourceKey: "device:inode",
    observedAt: "mapping-observed", observationOnly: true, requiresRevalidation: true, runReady: false };
  return { ref: { mappingId: "mapping", contentDigest: hash(body) }, ...body };
}
function detach() {
  const old = snapshot(1), map = mapping(old);
  const body = { attachment: { executionBindingId: "execution", groupBindingId: "binding", runtimeId: "runtime" }, profileRef: profileVersion(2).ref,
    bindingRef: bindingRow().ref, root: { state: "fixed_reference", workspaceRef: map.workspaceRef, mappingRef: map.ref,
      canonicalRoot: map.canonicalRoot, physicalResourceKey: map.physicalResourceKey, rootIdentity: map.rootIdentity,
      observedAt: "root-observed", requiresRevalidation: true, runReady: false },
    currentAdvanced: { stored: { state: "none" }, effectiveStrategy: null, validity: "not_selected", blockedReasons: [] },
    resolution: { state: "complete", backend: "claude-code", config: config(), advancedStrategy: null, semanticDigest: semantic() },
    requested: { state: "blocked", snapshotRef: old.ref, reasons: ["mapping-unavailable"] },
    applied: { state: "mapped", snapshotRef: old.ref, mappingRef: map.ref }, observedAt: "detach-observed", readOnly: true, runReady: false };
  return { ref: { detachSnapshotId: "detach", contentDigest: hash(body) }, ...body };
}
function receipt() {
  const body = { requestId: "request", planRef: { planId: "plan", digest: h() }, physicalSourceRef: evidence("physical"), snapshotReceiptRef: evidence("snapshot"),
    captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h("b") }, schemaBeforeDigest: h("c"), schemaAfterDigest: h("d"),
    guardTransition: { protocolBefore: 1, protocolAfter: 2, guardBeforeDigest: h("e"), guardAfterDigest: h("f"), schemaBeforeDigest: h("c"), schemaAfterDigest: h("d"),
      writerFormat: "s2-profile-config/v1", writerFormatDigest: h(), registeredUpgrade: evidence("upgrade") }, allowedDeltaManifest: evidence("delta"),
    targetRowsDigest: h(), sourceToTargetManifest: evidence("manifest"), committedAuthority: "profile" };
  return { ref: { activationId: "activation", digest: hash(body) }, ...body };
}
function captureBody(backend = "sqlite") {
  const old = ["agents", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "members", "projects", "groups", "group_participants", "agent_legacy_aliases"];
  const keys: Record<string, string[]> = { agent_runner_states: ["binding_id"], agent_runtime_members: ["member_id"], group_participants: ["group_id", "member_id"], agent_legacy_aliases: ["display_name", "host_type"] };
  return { contract: "m2-legacy-capture-body/r1", captureId: "capture", physicalSourceRef: evidence("physical"), snapshotReceiptRef: evidence("snapshot"),
    source: { kind: backend, databaseInstanceId: "1".repeat(32), identityDigest: h() }, textEncoding: { backend, name: backend === "sqlite" ? "UTF-16le" : "UTF8" },
    persistedAliases: true, legacySourceDigest: h("c"), tables: old.map((name, index) => {
      const primary = keys[name] ?? ["id"];
      const cells = primary.map(() => ["text", "6162"]);
      const additional = index === 0 ? ["raw", "null_value", "minimum", "maximum", "blob_value", "real_value"] : [];
      if (index === 0) cells.push(["text", "ff00"], ["null"], ["integer", "-9223372036854775808"], ["integer", "9223372036854775807"], ["blob", "00ff"], ["real64be", "7ff8000000000001"]);
      return { name, columnContract: artifact(`columns-${name}`), columns: [...primary, ...additional], count: "1", rows: [{ rowid: backend === "sqlite" ? String(index + 1) : null, cells }] };
    }) };
}
function captureRow(backend = "sqlite") {
  const capture = captureBody(backend);
  return { ref: { captureId: capture.captureId, sourceDigest: capture.legacySourceDigest, artifactDigest: hash(capture) }, physicalSourceRef: capture.physicalSourceRef, snapshotReceiptRef: capture.snapshotReceiptRef, capture };
}
function mutation(operation = "profile.save", actorScope = "actor") {
  const profile = operation !== "binding.save", ref = profile ? profileVersion(operation === "profile.create" ? 1 : 2).ref : bindingRow().ref;
  return { actorScope, operation, targetScope: profile ? { kind: "agent", agentId: "agent" } : { kind: "binding", groupBindingId: "binding" },
    mutationId: "same-mutation", commandDigest: h(), result: { kind: profile ? "profile" : "binding", saved: { ref, mutationId: "same-mutation", pendingApply: true, missing: ["kept", "kept"] } }, auditId: "audit" };
}

test("PA-19 R05 preserves ten complete native tables, raw encodings, integer extremes and all artifact references", async t => {
  for (const backend of ["sqlite", "postgres"]) {
    const value = captureRow(backend), p = success(encodeM2RowValue({ table: "legacy_config_captures", value }));
    const decoded = success(decodeM2RowValue(p)); assert.deepEqual(decoded.value, value); assert.deepEqual(decoded.foreignKeys, []);
    assert.equal(decoded.artifactRefs.filter(r => r.kind === "artifact").length, 10);
    assert(decoded.artifactRefs.some(r => r.path.join(".") === "capture.tables.9.columnContract"));
    assert.deepEqual(p.cells.capture_json, text(canonicalJson(value.capture)));
    assert.deepEqual(p.cells.artifact_digest, text(hash(value.capture)));
  }
  for (const [name, change] of [
    ["missing table", (body: ReturnType<typeof captureBody>) => { body.tables.pop(); }],
    ["wrong order", (body: ReturnType<typeof captureBody>) => { body.tables.reverse(); }],
    ["duplicate column", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.columns[1] = "id"; }],
    ["cell count", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.rows[0]!.cells.pop(); }],
    ["wrong count", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.count = "2"; }],
    ["duplicate typed PK", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.rows.push({ ...body.tables[0]!.rows[0]!, rowid: "2" }); body.tables[0]!.count = "2"; }],
    ["int64 overflow", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.rows[0]!.cells[3] = ["integer", "9223372036854775808"]; }],
    ["uppercase hex", (body: ReturnType<typeof captureBody>) => { body.tables[0]!.rows[0]!.cells[1] = ["text", "FF00"]; }],
    ["wrong source ref", (body: ReturnType<typeof captureBody>) => { body.physicalSourceRef = evidence("other"); }],
  ] as const) await t.test(name, () => {
    const value = captureRow(); change(value.capture); value.ref.artifactDigest = hash(value.capture);
    assert.equal(encodeM2RowValue({ table: "legacy_config_captures", value }).ok, false);
  });
  const pg = captureRow("postgres"); pg.capture.tables[0]!.rows[0]!.rowid = "1"; pg.ref.artifactDigest = hash(pg.capture);
  rejected(encodeM2RowValue({ table: "legacy_config_captures", value: pg }), "value_conflict");
});

test("PA-21 R11 full mutation receipt covers all operations, canonical target, result branch and stable actor scope", () => {
  for (const operation of ["profile.create", "profile.save", "binding.save"]) for (const actor of ["actor", "other-actor"]) {
    const value = mutation(operation, actor), p = success(encodeM2RowValue({ table: "config_mutation_receipts", value }));
    const decoded = success(decodeM2RowValue(p)); assert.deepEqual(decoded.value, value); assert.equal(Object.keys(p.cells).length, 13);
    assert.deepEqual(p.cells.target_scope, text(canonicalJson(value.targetScope))); assert.equal(decoded.foreignKeys.length, 2);
    assert.equal(decoded.foreignKeys[1]!.targetTable, "audit_log");
    assert.deepEqual(p.cells[operation === "binding.save" ? "result_profile_agent_id" : "result_binding_id"], nil);
    rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, target_scope: text(` ${canonicalJson(value.targetScope)}`) } }), "value_conflict");
  }
  rejected(encodeM2RowValue({ table: "config_mutation_receipts", value: mutation("binding.create") }), "unsupported_shape");
  const mismatch = mutation(); mismatch.result.saved.mutationId = "other";
  rejected(encodeM2RowValue({ table: "config_mutation_receipts", value: mismatch }), "value_conflict");
  const p = success(encodeM2RowValue({ table: "config_mutation_receipts", value: mutation() }));
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, result_profile_digest: text(h("f")) } }), "value_conflict");
});

test("PA-17/18 R06 roundtrips full profile and all three different legacy sources without rewriting raw history", () => {
  for (const value of [snapshot(), legacySnapshot("effective"), legacySnapshot("requestedSnapshot"), legacySnapshot("applied")]) {
    const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "config_snapshots", value }))));
    assert.deepEqual(decoded.value, value); assert.equal(Object.keys(decoded.projection.cells).length, 18);
    assert.deepEqual(decoded.projection.cells.origin_kind, text(value.origin.kind));
    assert.equal(decoded.foreignKeys.length, value.origin.kind === "profile" ? 4 : 3);
    const column = value.origin.kind === "profile" ? "capture_id" : "profile_revision";
    assert.deepEqual(decoded.projection.cells[column], nil);
  }
  const p = success(encodeM2RowValue({ table: "config_snapshots", value: snapshot() }));
  for (const column of ["agent_id", "group_binding_id", "execution_binding_id", "project_id", "member_id", "group_id", "origin_kind", "semantic_digest", "profile_digest", "binding_digest"])
    rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, [column]: text(column.endsWith("digest") ? h("f") : "other") } }), "value_conflict");
  const { ref, ...previewBody } = snapshot(); previewBody.executionBindingId = null as unknown as string;
  const preview = { ...previewBody, ref: { ...ref, contentDigest: hash(previewBody) } };
  const previewDecoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "config_snapshots", value: preview }))));
  assert.equal(previewDecoded.foreignKeys.length, 3);
});

test("PA-17/18 R07 complete Detach retains P2 current and P1 applied and all 28 source projections", () => {
  const value = detach(), p = success(encodeM2RowValue({ table: "config_detach_snapshots", value }));
  const decoded = success(decodeM2RowValue(p)); assert.deepEqual(decoded.value, value);
  assert.equal(Object.keys(p.cells).length, 28); assert.equal(decoded.foreignKeys.length, 11);
  assert.deepEqual(p.cells.profile_revision, integer(2)); assert.deepEqual(p.cells.applied_snapshot_id, text("snapshot-1"));
  assert.deepEqual(p.cells.requested_mapping_id, nil); assert.deepEqual(p.cells.root_mapping_id, text("mapping"));
  for (const column of ["requested_snapshot_id", "requested_snapshot_digest", "applied_snapshot_id", "applied_snapshot_digest", "applied_mapping_id", "applied_mapping_digest", "root_mapping_id", "root_mapping_digest", "root_workspace_project_id"])
    rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, [column]: text(column.endsWith("digest") ? h("f") : "other") } }), "value_conflict");
  const { ref, ...body } = value;
  const incomplete = { ...body, root: { state: "missing", workspaceRef: null, reasons: ["root unavailable"], runReady: false },
    resolution: { state: "incomplete", backend: null, partialConfig: { workdir: "" }, reasons: ["unresolved"] }, requested: null, applied: null };
  const missing = { ...incomplete, ref: { ...ref, contentDigest: hash(incomplete) } };
  const absent = success(decodeM2RowValue(success(encodeM2RowValue({ table: "config_detach_snapshots", value: missing }))));
  assert.deepEqual(absent.value, missing); assert.equal(absent.foreignKeys.length, 3);
  for (const column of ["requested_source_json", "applied_source_json", "root_workspace_project_id", "root_workspace_revision", "root_mapping_id", "root_mapping_digest"]) assert.deepEqual(absent.projection.cells[column], nil);
});

test("PA-17 R08 keeps all mapping fields and exact snapshot/workspace references", () => {
  const value = mapping(), p = success(encodeM2RowValue({ table: "config_workspace_mappings", value }));
  const decoded = success(decodeM2RowValue(p)); assert.deepEqual(decoded.value, value); assert.equal(decoded.foreignKeys.length, 3);
  assert.equal(Object.keys(p.cells).length, 11); assert.deepEqual(p.cells.root_identity_json, text(canonicalJson(value.rootIdentity)));
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, original_workdir: text("/later") } }), "value_conflict");
});

test("PA-S1-03/04/05/06 R09 uses the actual registered F1 and preserves all three source-binding branches", () => {
  assert.equal(M2_FORMAT_REGISTRATION.state, "registered-stage1"); assert.equal(M2_FORMAT_REGISTRATION.configFormat, 1);
  const branches = [
    { singleton: 1, formatVersion: 1, owner: "legacy", activationId: null, sourceBinding: { contract: "m2-source-binding/r1", kind: "legacy", physicalSourceRef: evidence("physical") } },
    { singleton: 1, formatVersion: 1, owner: "profile", activationId: "activation", sourceBinding: { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: evidence("physical"), activation: receipt().ref } },
    { singleton: 1, formatVersion: 1, owner: "profile", activationId: "activation", sourceBinding: { contract: "m2-source-binding/r1", kind: "imported", importArtifact: artifact("import"), importValueDigest: h("c") } },
  ];
  for (const value of branches) {
    const p = success(encodeM2RowValue({ table: "config_authority", value })), decoded = success(decodeM2RowValue(p));
    assert.deepEqual(decoded.value, value); assert.deepEqual(p.cells.source_binding_ref, text(canonicalJson(value.sourceBinding)));
    assert.equal(decoded.foreignKeys.length, value.owner === "legacy" ? 0 : 1);
    for (const formatVersion of [2, 3, 2147483647]) rejected(encodeM2RowValue({ table: "config_authority", value: { ...value, formatVersion } }), "unsupported_shape");
    for (const formatVersion of [0, -0, -1, 1.5, "1", 2147483648]) rejected(encodeM2RowValue({ table: "config_authority", value: { ...value, formatVersion } }), "invalid_value");
  }
  rejected(encodeM2RowValue({ table: "config_authority", value: { ...branches[0], activationId: "activation" } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "config_authority", value: { ...branches[1], activationId: "different" } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "config_authority", value: { ...branches[2], owner: "legacy" } }), "value_conflict");
});

test("PA-20 R10 preserves full receipt and each EvidenceRef with no self/authority digest cycle", () => {
  const value = receipt(), p = success(encodeM2RowValue({ table: "config_activation_receipts", value }));
  const decoded = success(decodeM2RowValue(p)); assert.deepEqual(decoded.value, value); assert.equal(Object.keys(p.cells).length, 17);
  const { ref, ...body } = value;
  assert.deepEqual(p.cells.payload_json, text(canonicalJson(body))); assert.deepEqual(p.cells.payload_digest, text(ref.digest));
  assert.equal(decoded.foreignKeys.length, 1); assert.equal(decoded.artifactRefs.length, 5);
  for (const column of ["request_id", "plan_id", "plan_digest", "capture_id", "capture_source_digest", "capture_artifact_digest", "schema_before_digest", "schema_after_digest", "target_rows_digest"])
    rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, [column]: text(column.endsWith("digest") ? h("f") : "other") } }), "value_conflict");
});

test("PA-17/18 R02 preserves canonical Profile content and fixed Role/compat revisions", () => {
  const version = profileVersion(), value = { version, compatRuntimeRevision: null };
  const p = success(encodeM2RowValue({ table: "agent_profile_versions", value }));
  assert.deepEqual(p.cells, { agent_id: text("agent"), revision: integer(2), content_json: text(canonicalJson(version.content)),
    content_digest: text(version.ref.contentDigest), default_role_id: nil, default_role_revision: nil, compat_runtime_revision: nil });
  assert.deepEqual(success(decodeM2RowValue(p)).value, value);
  const roleContent = { ...profileContent(), defaultRoleRef: { roleTemplateId: "role", revision: 2147483647 } };
  const roleValue = { version: { ref: { ...version.ref, contentDigest: hash(roleContent) }, content: roleContent }, compatRuntimeRevision: 7 };
  const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "agent_profile_versions", value: roleValue }))));
  assert.deepEqual(decoded.value, roleValue); assert.equal(decoded.foreignKeys.length, 2);
  assert.deepEqual(decoded.foreignKeys[1]!.targetColumns, ["role_template_id", "revision"]);
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, content_json: text(` ${canonicalJson(version.content)}`) } }), "value_conflict");
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, default_role_id: text("invented") } }), "value_conflict");
  const overflow = { ...roleContent, defaultRoleRef: { roleTemplateId: "role", revision: 2147483648 } };
  rejected(encodeM2RowValue({ table: "agent_profile_versions", value: { version: { ref: { ...version.ref, contentDigest: hash(overflow) }, content: overflow }, compatRuntimeRevision: null } }), "invalid_value");
});

test("PA-18 R04 derives all ten Advanced projections without supplying a false complete Binding scope", () => {
  const inactive = { state: "retained_inactive", original: { strategy: "bypassPermissions", runtimeRevision: 7, bindingRevision: 8 },
    captureRef: { captureId: "capture", sourceDigest: h(), artifactDigest: h("b") }, reason: "migration_reconfirmation_required" };
  for (const advanced of [{ state: "none" }, selected(), inactive]) {
    const value = bindingRow(advanced), decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "group_binding_config_versions", value }))));
    assert.deepEqual(decoded.value, value); assert.equal(Object.hasOwn(decoded.value, "agentId"), false);
    assert.deepEqual(decoded.projection.cells.advanced_state, text(advanced.state));
    assert.equal(Object.keys(decoded.projection.cells).length, 18);
  }
  const value = { ...bindingRow(selected()), compatibility: { executionBindingId: "execution", bindingRevision: 8 } };
  const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "group_binding_config_versions", value }))));
  assert.deepEqual(decoded.projection.cells.advanced_profile_agent_id, text("agent"));
  assert.deepEqual(decoded.projection.cells.advanced_capture_id, nil);
  assert.deepEqual(decoded.projection.cells.advanced_workspace_revision, integer(1));
  assert.equal(decoded.foreignKeys.length, 5);
  for (const column of ["compat_execution_binding_id", "compat_binding_revision"])
    rejected(decodeM2RowValue({ ...decoded.projection, cells: { ...decoded.projection.cells, [column]: nil } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "group_binding_config_versions", value: { ...value, compatibility: { executionBindingId: "other", bindingRevision: 8 } } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "group_binding_config_versions", value: { ...value, compatibility: { executionBindingId: "execution", bindingRevision: 3 } } }), "value_conflict");
  const wrong = selected(); wrong.basis.bindingConfigRevision = 4;
  rejected(encodeM2RowValue({ table: "group_binding_config_versions", value: bindingRow(wrong) }), "value_conflict");
});

test("PA-18 R03 derives attached state and preserves retired identity without inventing an attachment", () => {
  const value = { id: "binding", projectId: "project", groupId: "group", memberId: "member", agentId: "agent", currentRevision: 3,
    originalLegacyBindingId: "old", currentAttachmentId: "execution", currentCompatBindingRevision: 9, retiredAt: null };
  const projected = success(encodeM2RowValue({ table: "group_bindings", value }));
  assert.deepEqual(projected.cells.current_attachment_state, text("attached"));
  const decoded = success(decodeM2RowValue(projected)); assert.deepEqual(decoded.value, value);
  assert(decoded.foreignKeys.some(f => f.constraintId === "fk:group_bindings:current_attachment_id,id,current_attachment_state->agent_runtime_bindings:id,group_binding_id,attachment_state" && f.deferrable));
  assert(decoded.remainingSourceChecks.includes("attachment_bijection"));
  const retired = { ...value, currentAttachmentId: null, currentCompatBindingRevision: null, retiredAt: "old timestamp" };
  assert.deepEqual(success(decodeM2RowValue(success(encodeM2RowValue({ table: "group_bindings", value: retired })))).value, retired);
  rejected(encodeM2RowValue({ table: "group_bindings", value: { ...value, retiredAt: "retired" } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "group_bindings", value: { ...value, currentAttachmentState: "attached" } }), "invalid_value");
  rejected(encodeM2RowValue({ table: "group_bindings", value: { ...value, currentCompatBindingRevision: null } }), "value_conflict");
});

test("PA-22 / PA-S1-11 E01 returns only complete deferred new edges and leaves old scope to the real row join", () => {
  const base = { executionBindingId: "execution", groupBindingId: "binding", attachmentState: "attached", detachSnapshotId: null,
    detachedAt: null, requestedSnapshotId: null, requestedMappingId: null };
  const noRefs = success(decodeM2RowValue(success(encodeM2RowValue({ table: "execution-binding-references", value: base }))));
  assert.equal(noRefs.table, "execution-binding-references"); assert.deepEqual(noRefs.foreignKeys, []);
  assert.deepEqual(noRefs.projection, { contract: "m2-execution-reference-projection/r1", table: "agent_runtime_bindings", identity: { id: "execution" }, cells: {
    group_binding_id: text("binding"), attachment_state: text("attached"), detach_config_snapshot_id: nil, detached_at: nil,
    requested_config_snapshot_id: nil, requested_workspace_mapping_id: nil,
  } });
  for (const item of ["fk_existence", "scope_alignment", "attachment_bijection"]) assert(noRefs.remainingSourceChecks.includes(item as never));
  const detached = { ...base, attachmentState: "detached", detachSnapshotId: "detach", detachedAt: "observed", requestedSnapshotId: "snapshot", requestedMappingId: "mapping" };
  const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "execution-binding-references", value: detached }))));
  assert.deepEqual(decoded.value, detached); assert.equal(decoded.foreignKeys.length, 3);
  assert.deepEqual(decoded.foreignKeys.map(f => [f.targetTable, f.targetColumns, f.key, f.onDelete, f.deferrable]), [
    ["config_detach_snapshots", ["id", "execution_binding_id", "group_binding_id"], [text("detach"), text("execution"), text("binding")], "NO ACTION", true],
    ["config_snapshots", ["id", "execution_binding_id", "group_binding_id"], [text("snapshot"), text("execution"), text("binding")], "NO ACTION", true],
    ["config_workspace_mappings", ["id", "snapshot_id"], [text("mapping"), text("snapshot")], "NO ACTION", true],
  ]);
  assert(decoded.foreignKeys.every(f => f.targetTable !== "group_bindings"));
  const unmapped = success(decodeM2RowValue(success(encodeM2RowValue({ table: "execution-binding-references", value: { ...base, requestedSnapshotId: "unmapped" } }))));
  assert.equal(unmapped.foreignKeys.length, 1); assert.equal(unmapped.foreignKeys[0]!.targetTable, "config_snapshots");
  rejected(encodeM2RowValue({ table: "execution-binding-references", value: { ...base, requestedMappingId: "mapping" } }), "value_conflict");
  rejected(encodeM2RowValue({ table: "execution-binding-references", value: { ...base, attachmentState: "detached" } }), "value_conflict");
  rejected(decodeM2RowValue({ ...noRefs.projection, contract: "m2-row-projection/r1" }), "unsupported_shape");
});

test("PA-22 E02 allows a snapshot without mapping and emits only immediate complete references", () => {
  const value = { bindingId: "execution", appliedSnapshotId: "snapshot", appliedMappingId: "mapping" };
  const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table: "runner-applied-references", value }))));
  assert.deepEqual(decoded.value, value); assert.equal(decoded.foreignKeys.length, 2);
  assert(decoded.foreignKeys.every(f => f.onDelete === "RESTRICT" && f.deferrable === false));
  const empty = success(decodeM2RowValue(success(encodeM2RowValue({ table: "runner-applied-references", value: { ...value, appliedSnapshotId: null, appliedMappingId: null } }))));
  assert.deepEqual(empty.foreignKeys, []);
  const unmapped = success(decodeM2RowValue(success(encodeM2RowValue({ table: "runner-applied-references", value: { ...value, appliedMappingId: null } }))));
  assert.equal(unmapped.foreignKeys.length, 1);
  rejected(encodeM2RowValue({ table: "runner-applied-references", value: { ...value, appliedSnapshotId: null } }), "value_conflict");
});

test("PA-02/03 row envelopes reject hostile data without invoking getters or mutating callers", async t => {
  const base = () => ({ table: "agent_profiles", value: { ...head } });
  let callbacks = 0;
  const invalid: [string, () => unknown][] = [
    ["accessor", () => Object.defineProperty(base(), "value", { enumerable: true, get() { callbacks++; return head; } })],
    ["toJSON", () => Object.assign(base(), { toJSON() { callbacks++; } })],
    ["symbol", () => Object.assign(base(), { [Symbol("hidden")]: 1 })],
    ["hidden", () => Object.defineProperty(base(), "hidden", { value: 1 })],
    ["undefined", () => ({ ...base(), x: undefined })], ["bigint", () => ({ ...base(), x: 1n })],
    ["custom prototype", () => Object.assign(Object.create({}), base())], ["date", () => ({ ...base(), x: new Date(0) })],
    ["map", () => ({ ...base(), x: new Map() })], ["set", () => ({ ...base(), x: new Set() })],
    ["cycle", () => { const v = base(); return Object.assign(v, { cycle: v }); }],
    ["sparse", () => ({ ...base(), x: [, null] })], ["array extra", () => ({ ...base(), x: Object.assign([], { x: 1 }) })],
    ["array prototype", () => ({ ...base(), x: Object.setPrototypeOf([], {}) })],
    ["missing descriptor", () => new Proxy(base(), { getOwnPropertyDescriptor(target, key) { return key === "value" ? undefined : Object.getOwnPropertyDescriptor(target, key); } })],
    ["throwing proxy", () => new Proxy(base(), { ownKeys() { throw Object.defineProperty({}, "message", { get() { callbacks++; return "secret"; } }); } })],
    ...[NaN, Infinity, -Infinity, -0, 1.5, Number.MAX_SAFE_INTEGER + 1].map(n => [String(n), () => ({ table: "agent_profiles", value: { ...head, currentRevision: n } })] as [string, () => unknown]),
  ];
  for (const [name, value] of invalid) await t.test(name, () => rejected(encodeM2RowValue(value()), "invalid_value"));
  assert.equal(callbacks, 0);
  let keys = 0; const original = base();
  const proxy = new Proxy(original, { ownKeys(target) { assert.equal(++keys, 1); return Reflect.ownKeys(target); } });
  assert.deepEqual(success(encodeM2RowValue(proxy)), headProjection); assert.equal(keys, 1);
  assert.equal(Object.isFrozen(original), false); assert.equal(Object.isFrozen(original.value), false);
  assert.deepEqual(success(encodeM2RowValue(Object.assign(Object.create(null), base()))), headProjection);
  const sharedCell = { kind: "null" }; const shared = { ...headProjection, cells: { ...headProjection.cells, legacy_runtime_id: sharedCell, compat_runtime_revision: sharedCell } };
  const copied = success(decodeM2RowValue(shared)).projection.cells;
  assert.notEqual(copied.legacy_runtime_id, copied.compat_runtime_revision); assert.equal(Object.isFrozen(sharedCell), false);
});

test("PA-04 row envelope accounts exact canonical bytes, repeated values, depth and total nodes", () => {
  const base = { table: "agent_profiles", value: { ...head, agentId: "" } };
  const remaining = 16777216 - Buffer.byteLength(canonicalJson(base));
  const atLimit = { ...base, value: { ...base.value, agentId: "x".repeat(remaining) } };
  assert.equal(Buffer.byteLength(canonicalJson(atLimit)), 16777216);
  success(encodeM2RowValue(atLimit));
  rejected(encodeM2RowValue({ ...base, value: { ...base.value, agentId: "x".repeat(remaining + 1) } }), "budget_exceeded");
  rejected(encodeM2RowValue({ table: "agent_profiles", value: head, x: "\0".repeat(3000000) }), "budget_exceeded");
  const shared = { text: "x".repeat(9000000) };
  rejected(encodeM2RowValue({ table: "agent_profiles", value: head, x: [shared, shared] }), "budget_exceeded");
  let depth: unknown = 0; for (let i = 0; i < 65; i++) depth = [depth];
  rejected(encodeM2RowValue({ table: "agent_profiles", value: head, depth }), "budget_exceeded");
  let dag: unknown = 0; for (let i = 0; i < 18; i++) dag = [dag, dag];
  rejected(encodeM2RowValue({ table: "agent_profiles", value: head, dag }), "budget_exceeded");
});

test("PA-17/23 row column shape, scalar domains and portable standalone TEXT are strict", async t => {
  for (const decimal of ["0", "-0", "01", "+1", "1.0", "1e0", "-1", "9007199254740992"]) await t.test(decimal, () => {
    rejected(decodeM2RowValue({ ...headProjection, cells: { ...headProjection.cells, current_revision: { kind: "integer", decimal } } }), "invalid_value");
  });
  for (const value of ["a\0b", "\ud800", "\udc00"]) rejected(encodeM2RowValue({ table: "agent_profiles", value: { ...head, agentId: value } }), "unsupported_shape");
  const { compat_runtime_revision: _omitted, ...missing } = headProjection.cells;
  rejected(decodeM2RowValue({ ...headProjection, cells: missing }), "invalid_value");
  rejected(decodeM2RowValue({ ...headProjection, cells: { ...headProjection.cells, unknown: nil } }), "invalid_value");
  rejected(decodeM2RowValue({ ...headProjection, cells: { ...headProjection.cells, current_revision: text("2") } }), "invalid_value");
  rejected(decodeM2RowValue({ ...headProjection, cells: { ...headProjection.cells, agent_id: { kind: "blob", value: "00" } } }), "unsupported_shape");
  rejected(encodeM2RowValue({ table: "future", value: head }), "unsupported_shape");
  rejected(decodeM2RowValue({ ...headProjection, contract: "future" }), "unsupported_shape");
  rejected(encodeM2RowValue({ table: "agent_profiles", value: head, registry: M2_FORMAT_REGISTRATION }), "invalid_value");
});

function fullRows(): [string, unknown][] {
  const content = { ...profileContent(), defaultRoleRef: { roleTemplateId: "role", revision: 1 } };
  const choice = selected(), legacyChoice = { ...choice, origin: { kind: "legacy_equivalence", captureRef: captureRow().ref,
    legacyRef: { authority: "legacy", kind: "effective", sourceId: "execution", runtimeId: "runtime", bindingId: "execution", agentId: "agent",
      digest: h(), versions: { runtimeRevision: 7, bindingRevision: 8 }, configVersion: 1 } } };
  const binding = { ...bindingContent(legacyChoice), roleRef: { roleTemplateId: "role", revision: 1 } };
  const { ref, ...body } = detach(), both = { ...body, requested: body.applied };
  return [
    ["agent_profiles", { ...head, legacyRuntimeId: "runtime", compatRuntimeRevision: 7 }],
    ["agent_profile_versions", { version: { ref: { ...profileVersion().ref, contentDigest: hash(content) }, content }, compatRuntimeRevision: 7 }],
    ["group_bindings", { id: "binding", projectId: "project", groupId: "group", memberId: "member", agentId: "agent", currentRevision: 3,
      originalLegacyBindingId: "original", currentAttachmentId: "execution", currentCompatBindingRevision: 8, retiredAt: null }],
    ["group_binding_config_versions", { ref: { ...bindingRow().ref, contentDigest: hash(binding) }, content: binding, compatibility: { executionBindingId: "execution", bindingRevision: 8 } }],
    ["legacy_config_captures", captureRow()], ["config_snapshots", snapshot()],
    ["config_detach_snapshots", { ...both, ref: { ...ref, contentDigest: hash(both) } }], ["config_workspace_mappings", mapping()],
    ["config_authority", { singleton: 1, formatVersion: 1, owner: "profile", activationId: "activation", sourceBinding: { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: evidence("physical"), activation: receipt().ref } }],
    ["config_activation_receipts", receipt()], ["config_mutation_receipts", mutation()],
    ["execution-binding-references", { executionBindingId: "execution", groupBindingId: "binding", attachmentState: "detached", detachSnapshotId: "detach", detachedAt: "observed", requestedSnapshotId: "snapshot", requestedMappingId: "mapping" }],
    ["runner-applied-references", { bindingId: "execution", appliedSnapshotId: "snapshot", appliedMappingId: "mapping" }],
  ];
}

test("PA-17 every one of 138 relation columns and 8 fragment columns rejects omission and wrong cell type", async t => {
  let count = 0;
  for (const [table, value] of fullRows()) {
    const p = success(encodeM2RowValue({ table, value }));
    assert.deepEqual(success(decodeM2RowValue(p)).value, value);
    const info = [...M2_COLUMN_CONTRACT.relations, ...M2_COLUMN_CONTRACT.executionFragments].find(r => r.table === p.table)!;
    assert.deepEqual(Object.keys(p.cells), info.columns.map(c => c.name));
    for (const column of info.columns) await t.test(`${table}.${column.name}`, () => {
      count++;
      const missing = { ...p.cells }; delete missing[column.name];
      rejected(decodeM2RowValue({ ...p, cells: missing }), "invalid_value");
      const wrong = ["N", "I", "F", "INTEGER"].includes(column.domain) ? text("1") : integer(1);
      rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, [column.name]: wrong } }), "invalid_value");
      const c = p.cells[column.name]!;
      if ((column.domain === "J" || column.name === "target_scope") && c.kind === "text")
        rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, [column.name]: text(` ${c.value}`) } }), "value_conflict");
    });
    rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, unknown_column: nil } }), "invalid_value");
  }
  assert.equal(count, 146);
});

test("PA-17/22 all 50 available new FK edges retain exact target keys and R/D semantics", () => {
  const seen = new Set<string>();
  for (const [table, value] of [...fullRows(), ["config_snapshots", legacySnapshot()], ["config_mutation_receipts", mutation("binding.save")]]) {
    const decoded = success(decodeM2RowValue(success(encodeM2RowValue({ table, value }))));
    for (const fk of decoded.foreignKeys) {
      assert(fk.key.every(c => c.kind !== "null"));
      assert.equal(fk.key.length, fk.targetColumns.length);
      assert.equal(fk.onDelete, fk.deferrable ? "NO ACTION" : "RESTRICT");
      seen.add(`${fk.constraintId}|${fk.deferrable ? "D" : "R"}`);
    }
  }
  const expected = `agent_profiles:agent_id->agents:id|R
agent_profiles:agent_id,current_revision->agent_profile_versions:agent_id,revision|D
agent_profiles:legacy_runtime_id->agent_runtimes:id|R
agent_profile_versions:agent_id->agent_profiles:agent_id|R
agent_profile_versions:default_role_id,default_role_revision->role_template_versions:role_template_id,revision|R
group_bindings:agent_id->agent_profiles:agent_id|R
group_bindings:project_id->projects:id|R
group_bindings:group_id->groups:id|R
group_bindings:member_id->members:id|R
group_bindings:id,current_revision->group_binding_config_versions:binding_id,revision|D
group_bindings:original_legacy_binding_id->agent_runtime_bindings:id|D
group_bindings:current_attachment_id,id,current_attachment_state->agent_runtime_bindings:id,group_binding_id,attachment_state|D
group_binding_config_versions:binding_id->group_bindings:id|R
group_binding_config_versions:role_id,role_revision->role_template_versions:role_template_id,revision|R
group_binding_config_versions:compat_execution_binding_id,binding_id->agent_runtime_bindings:id,group_binding_id|R
group_binding_config_versions:advanced_profile_agent_id,advanced_profile_revision,advanced_profile_digest->agent_profile_versions:agent_id,revision,content_digest|R
group_binding_config_versions:advanced_capture_id,advanced_capture_source_digest,advanced_capture_artifact_digest->legacy_config_captures:id,source_digest,artifact_digest|R
group_binding_config_versions:advanced_workspace_project_id,advanced_workspace_revision->project_workspace_versions:project_id,workspace_revision|R
group_binding_config_versions:advanced_execution_binding_id,binding_id->agent_runtime_bindings:id,group_binding_id|R
config_snapshots:group_binding_id,agent_id,project_id,group_id,member_id->group_bindings:id,agent_id,project_id,group_id,member_id|R
config_snapshots:execution_binding_id,group_binding_id->agent_runtime_bindings:id,group_binding_id|R
config_snapshots:capture_id,capture_source_digest,capture_artifact_digest->legacy_config_captures:id,source_digest,artifact_digest|R
config_snapshots:agent_id,profile_revision,profile_digest->agent_profile_versions:agent_id,revision,content_digest|R
config_snapshots:group_binding_id,binding_revision,binding_digest->group_binding_config_versions:binding_id,revision,content_digest|R
config_detach_snapshots:execution_binding_id,group_binding_id,runtime_id->agent_runtime_bindings:id,group_binding_id,runtime_id|D
config_detach_snapshots:profile_agent_id,profile_revision,profile_digest->agent_profile_versions:agent_id,revision,content_digest|R
config_detach_snapshots:group_binding_id,binding_revision,binding_digest->group_binding_config_versions:binding_id,revision,content_digest|R
config_detach_snapshots:requested_snapshot_id,requested_snapshot_digest->config_snapshots:id,content_digest|R
config_detach_snapshots:requested_snapshot_id,execution_binding_id->config_snapshots:id,execution_binding_id|R
config_detach_snapshots:requested_mapping_id,requested_mapping_digest->config_workspace_mappings:id,content_digest|R
config_detach_snapshots:requested_mapping_id,requested_snapshot_id->config_workspace_mappings:id,snapshot_id|R
config_detach_snapshots:applied_snapshot_id,applied_snapshot_digest->config_snapshots:id,content_digest|R
config_detach_snapshots:applied_snapshot_id,execution_binding_id->config_snapshots:id,execution_binding_id|R
config_detach_snapshots:applied_mapping_id,applied_mapping_digest->config_workspace_mappings:id,content_digest|R
config_detach_snapshots:applied_mapping_id,applied_snapshot_id->config_workspace_mappings:id,snapshot_id|R
config_detach_snapshots:root_workspace_project_id,root_workspace_revision->project_workspace_versions:project_id,workspace_revision|R
config_detach_snapshots:root_mapping_id,root_mapping_digest->config_workspace_mappings:id,content_digest|R
config_workspace_mappings:snapshot_id,snapshot_digest->config_snapshots:id,content_digest|R
config_workspace_mappings:snapshot_id,project_id->config_snapshots:id,project_id|R
config_workspace_mappings:project_id,workspace_revision->project_workspace_versions:project_id,workspace_revision|R
config_authority:activation_id->config_activation_receipts:id|R
config_activation_receipts:capture_id,capture_source_digest,capture_artifact_digest->legacy_config_captures:id,source_digest,artifact_digest|R
config_mutation_receipts:result_profile_agent_id,result_profile_revision,result_profile_digest->agent_profile_versions:agent_id,revision,content_digest|R
config_mutation_receipts:result_binding_id,result_binding_revision,result_binding_digest->group_binding_config_versions:binding_id,revision,content_digest|R
config_mutation_receipts:audit_id->audit_log:id|R
agent_runtime_bindings:detach_config_snapshot_id,id,group_binding_id->config_detach_snapshots:id,execution_binding_id,group_binding_id|D
agent_runtime_bindings:requested_config_snapshot_id,id,group_binding_id->config_snapshots:id,execution_binding_id,group_binding_id|D
agent_runtime_bindings:requested_workspace_mapping_id,requested_config_snapshot_id->config_workspace_mappings:id,snapshot_id|D
agent_runner_states:applied_config_snapshot_id,binding_id->config_snapshots:id,execution_binding_id|R
agent_runner_states:applied_workspace_mapping_id,applied_config_snapshot_id->config_workspace_mappings:id,snapshot_id|R`.split("\n").map(s => `fk:${s}`);
  assert.equal(expected.length, 50); assert.deepEqual([...seen].sort(), expected.sort());
});

test("PA-04 parsed JSON columns share the envelope node/depth budget", () => {
  const nodes = (v: unknown): number => 1 + (v !== null && typeof v === "object" ? Object.values(v).reduce<number>((n, item) => n + nodes(item), 0) : 0);
  const content = { ...profileContent(), legacyCompatibility: { tools: [] as string[], permissionMode: "auto" } };
  const value = { version: { ref: { ...profileVersion().ref, contentDigest: hash(content) }, content }, compatRuntimeRevision: null };
  const envelope = { table: "agent_profile_versions", value };
  content.legacyCompatibility.tools = Array(250000 - nodes(envelope)).fill(""); value.version.ref.contentDigest = hash(content);
  assert.equal(nodes(envelope), 250000); success(encodeM2RowValue(envelope));
  content.legacyCompatibility.tools.push(""); value.version.ref.contentDigest = hash(content);
  rejected(encodeM2RowValue(envelope), "budget_exceeded");
  const p = success(encodeM2RowValue({ table: "config_detach_snapshots", value: detach() }));
  const many = Array(84000).fill("");
  const resolution = { state: "incomplete", backend: null, partialConfig: {}, reasons: many };
  const root = { state: "missing", workspaceRef: null, reasons: many, runReady: false };
  const view = { stored: { state: "none" }, effectiveStrategy: null, validity: "not_selected", blockedReasons: many };
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, resolution_json: text(canonicalJson(resolution)), root_source_json: text(canonicalJson(root)), current_advanced_view_json: text(canonicalJson(view)) } }), "budget_exceeded");
  const nested = "[".repeat(65) + "0" + "]".repeat(65);
  rejected(decodeM2RowValue({ ...p, cells: { ...p.cells, resolution_json: text(nested) } }), "budget_exceeded");
});

test("PA-S1-08 data-only unregistered constants disable every complete R09 row without a registry API", async () => {
  const contractsUrl = new URL("../src/server/identity/m2-value-contracts.ts", import.meta.url), codecsUrl = new URL("../src/server/identity/m2-row-codecs.ts", import.meta.url);
  const contracts = await readFile(contractsUrl, "utf8"), codecs = await readFile(codecsUrl, "utf8");
  const prefix = contracts.slice(0, contracts.indexOf("export const M2_FORMAT_REGISTRATION:")); assert(prefix.endsWith("resolver.\n"));
  const disabled = { contract: "m2-value-format-registration/r1", state: "unregistered", schemaMigration: null, configFormat: null };
  const columns = { ...M2_COLUMN_CONTRACT, registration: { schemaMigration: null, configFormat: null } };
  const contractsCopy = prefix + `export const M2_FORMAT_REGISTRATION = freeze(${JSON.stringify(disabled)});\nexport const M2_COLUMN_CONTRACT = freeze(${JSON.stringify(columns)});\n`;
  const url = (source: string) => "data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64");
  const contractData = url(contractsCopy);
  const translated = codecs.replace(/from "([^"\n]+)"/g, (_all, specifier: string) => `from ${JSON.stringify(specifier === "./m2-value-contracts.ts" ? contractData : specifier.startsWith(".") ? new URL(specifier, codecsUrl).href : specifier)}`);
  const copy = await import(url(translated)) as typeof import("../src/server/identity/m2-row-codecs.ts");
  const values = [
    { singleton: 1, formatVersion: 1, owner: "legacy", activationId: null, sourceBinding: { contract: "m2-source-binding/r1", kind: "legacy", physicalSourceRef: evidence("physical") } },
    { singleton: 1, formatVersion: 1, owner: "profile", activationId: "activation", sourceBinding: { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: evidence("physical"), activation: receipt().ref } },
    { singleton: 1, formatVersion: 1, owner: "profile", activationId: "activation", sourceBinding: { contract: "m2-source-binding/r1", kind: "imported", importArtifact: artifact("import"), importValueDigest: h("c") } },
  ];
  for (const value of values) {
    const p = success(encodeM2RowValue({ table: "config_authority", value }));
    rejected(copy.encodeM2RowValue({ table: "config_authority", value }), "format_unregistered");
    rejected(copy.decodeM2RowValue(p), "format_unregistered");
  }
  assert.deepEqual(success(copy.encodeM2RowValue({ table: "agent_profiles", value: head })), headProjection);
});

test("PA-24 row runtime exports contain only the two pure value functions", async () => {
  assert.deepEqual(Object.keys(await import("../src/server/identity/m2-row-codecs.ts")).sort(), ["decodeM2RowValue", "encodeM2RowValue"]);
  for (const field of ["registry", "budget", "callback", "SQL", "SourceLock", "permit", "active"]) rejected(encodeM2RowValue({ table: "agent_profiles", value: head, [field]: true }), "invalid_value");
});

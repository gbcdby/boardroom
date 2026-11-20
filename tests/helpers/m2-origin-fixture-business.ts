import assert from "node:assert/strict";
import { encodeM2RowValue, decodeM2RowValue } from "../../src/server/identity/m2-row-codecs.ts";
import { snapshotRuntimeConfig } from "../../src/server/runtime/config.ts";
import { M2_HISTORY_TABLES } from "../../src/server/identity/m2-history-contracts.ts";
import type { RawCell, RawRow, RawTable } from "../../src/server/identity/m2-history-contracts.ts";
import type { M2Cell, M2RowProjection, M2ExecutionReferenceProjection } from "../../src/server/identity/m2-value-contracts.ts";
import { originCanonical, originCell, originDigest, originRow, originSha } from "./m2-origin-fixture-store.ts";
import type { m2OriginP0Fixture } from "./m2-origin-fixture-p0.ts";
import { originAdvancedWorkspace } from "./m2-origin-fixture-advanced.ts";

export type OriginProjection = M2RowProjection | M2ExecutionReferenceProjection;
export function originEncode(table: string, value: unknown): OriginProjection {
  const result = encodeM2RowValue({ table, value }); assert(result.ok, table + ": " + JSON.stringify(result));
  const decoded = decodeM2RowValue(result.value); assert(decoded.ok, table + ": " + JSON.stringify(decoded));
  return result.value;
}
export function originStoredCell(cell: M2Cell): RawCell {
  return cell.kind === "null" ? ["null"] : cell.kind === "integer" ? ["integer", cell.decimal] : originCell(cell.value);
}
export function originProjectionRow(projection: OriginProjection, columns: string[], rowid: string): RawRow {
  return { rowid, cells: columns.map(column => {
    const cell = projection.cells[column];
    if (cell) return originStoredCell(cell);
    assert("identity" in projection && Object.hasOwn(projection.identity, column), column);
    return originCell((projection.identity as Record<string, string>)[column]!);
  }) };
}
export function originSortRows(rows: RawRow[]): RawRow[] {
  return rows.sort((a, b) => Buffer.compare(Buffer.from(originCanonical([a.rowid, a.cells])), Buffer.from(originCanonical([b.rowid, b.cells]))));
}

/** Derive target rows from actual captured cells. Three old sources retain their
 * own raw JSON and revisions; workspace absence produces blocked observations. */
export function originBusiness(p0: Awaited<ReturnType<typeof m2OriginP0Fixture>>, seed: any, advancedWorkspace = false) {
  const { store, before } = p0, source = before.source, projections: OriginProjection[] = [];
  const table = (name: string) => { const result = before.tables.find(t => t.name === name); assert(result, name); return result; };
  const raw = (name: string) => originRow(table(name));
  const agent = raw("agents"), runtime = raw("agent_runtimes"), execution = raw("agent_runtime_bindings"), runner = raw("agent_runner_states");
  const captureTables = ["agents", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "members", "projects", "groups", "group_participants", "agent_legacy_aliases"];
  const capture = { contract: "m2-legacy-capture-body/r1", captureId: seed.captureId,
    physicalSourceRef: before.physicalSourceRef, snapshotReceiptRef: before.snapshotReceiptRef, source,
    textEncoding: before.textEncoding, persistedAliases: true, legacySourceDigest: p0.legacyCapture.sourceDigest,
    tables: captureTables.map(name => { const t = table(name); return { name, columnContract: t.columnContract,
      columns: t.columns, count: t.count, rows: t.rows }; }) };
  const captureArtifact = store.add("legacyCapture", "legacy-capture", capture,
    [p0.refs.physical, p0.refs.receipt, ...capture.tables.map(t => t.columnContract)], "raw");
  const captureRef = { captureId: seed.captureId, sourceDigest: capture.legacySourceDigest, artifactDigest: captureArtifact.sha256 };
  const defaults = JSON.parse(String(runtime.defaults_json)), overrides = JSON.parse(String(execution.overrides_json));
  const profileContent = { preferredHost: agent.host_type, model: defaults.model, instructions: defaults.systemPrompt,
    defaultRoleRef: null, skillSelection: [], toolSelection: [], memorySelection: [], maxConcurrentInstances: 1,
    legacyCompatibility: { tools: defaults.tools, permissionMode: defaults.permissionMode } };
  const profile = { ref: { agentId: "a", profileRevision: 1, contentDigest: originDigest(profileContent) }, content: profileContent };
  const bindingContent = { roleRef: null, profileOverrides: { model: overrides.model }, currentAdvanced: { state: "none" } };
  const binding = { ref: { groupBindingId: "b", bindingConfigRevision: 1, contentDigest: originDigest(bindingContent) }, content: bindingContent,
    compatibility: { executionBindingId: "b", bindingRevision: Number(execution.revision) } };
  const effective = snapshotRuntimeConfig("claude-code", { ...defaults, ...overrides },
    { runtimeRevision: Number(runtime.revision), bindingRevision: Number(execution.revision) }, advancedWorkspace ? "bypassPermissions" : null);
  const sources = [
    { kind: "requestedSnapshot", slot: "requested", rawJson: execution.requested_snapshot_json as string, snapshot: JSON.parse(String(execution.requested_snapshot_json)) },
    { kind: "applied", slot: "applied", rawJson: runner.applied_json as string, snapshot: JSON.parse(String(runner.applied_json)) },
    { kind: "effective", slot: "effective", rawJson: null, snapshot: effective },
  ];
  const snapshots = sources.map(item => {
    const snapshot = item.snapshot, legacyRef = { authority: "legacy", kind: item.kind, sourceId: "b", runtimeId: "r", bindingId: "b", agentId: "a",
      digest: snapshot.digest, versions: snapshot.versions, configVersion: Number(runtime.config_version) };
    const body = { agentId: "a", groupBindingId: "b", executionBindingId: "b", memberId: "m", projectId: "p", groupId: "g",
      backend: snapshot.backend, config: snapshot.config, advancedStrategy: snapshot.advancedStrategy, semanticDigest: snapshot.digest,
      origin: { kind: "legacy", legacyRef, raw: { captureRef, rawJson: item.rawJson, rawDigest: item.rawJson === null ? null : originSha(item.rawJson),
        rawAdvancedJson: null, rawAdvancedDigest: null } }, advancedBasis: { kind: "legacy", legacy: { originalSelection: null,
        originalValidity: "not_selected", mappedValidity: "not_selected", equivalenceEvidenceDigest: null } },
      legacyAlias: { displayName: agent.display_name, hostType: agent.host_type } };
    return { ref: { snapshotId: seed.bindings[0][item.slot].snapshotId, contentDigest: originDigest(body) }, ...body };
  });
  const advanced = advancedWorkspace ? originAdvancedWorkspace(p0, seed, profile, binding, snapshots, captureRef, captureArtifact) : undefined;
  const snapshot = (kind: string) => snapshots.find(value => value.origin.legacyRef.kind === kind)!;
  const values: Record<string, unknown[]> = {
    agent_profiles: [{ agentId: "a", currentRevision: 1, legacyRuntimeId: "r", compatRuntimeRevision: Number(runtime.revision) }],
    agent_profile_versions: [{ version: profile, compatRuntimeRevision: Number(runtime.revision) }],
    group_bindings: [{ id: "b", projectId: "p", groupId: "g", memberId: "m", agentId: "a", currentRevision: 1,
      originalLegacyBindingId: "b", currentAttachmentId: "b", currentCompatBindingRevision: Number(execution.revision), retiredAt: null }],
    group_binding_config_versions: [binding], legacy_config_captures: [{ ref: captureRef, physicalSourceRef: before.physicalSourceRef,
      snapshotReceiptRef: before.snapshotReceiptRef, capture }], config_snapshots: snapshots,
    config_detach_snapshots: [], config_workspace_mappings: advanced?.mappings ?? [], config_mutation_receipts: [],
  };
  const newTables = Object.keys(values).sort().map(name => {
    const columns = M2_HISTORY_TABLES.find(t => t.name === name)!.columnsP1.map(c => c.name);
    const rows = values[name]!.map((value, index) => { const projection = originEncode(name, value); projections.push(projection);
      return originProjectionRow(projection, columns, String(index + 1)); });
    return { table: name, columns, rows: originSortRows(rows), count: String(rows.length) };
  });
  const executionProjections = [originEncode("execution-binding-references", { executionBindingId: "b", groupBindingId: "b", attachmentState: "attached",
    detachSnapshotId: null, detachedAt: null, requestedSnapshotId: snapshot("requestedSnapshot").ref.snapshotId,
    requestedMappingId: advanced?.workspaces.get("requestedSnapshot")?.mappingRef.mappingId ?? null }),
  originEncode("runner-applied-references", { bindingId: "b", appliedSnapshotId: snapshot("applied").ref.snapshotId,
    appliedMappingId: advanced?.workspaces.get("applied")?.mappingRef.mappingId ?? null })];
  projections.push(...executionProjections);
  const executionReferences = executionProjections.map(projection => {
    assert("identity" in projection); const columns = [...Object.keys(projection.identity), ...Object.keys(projection.cells)];
    return { table: projection.table, columns, rows: [originProjectionRow(projection, columns, table(projection.table).rows[0]!.rowid!)], count: "1" };
  });
  const auditValues: Record<string, string | null> = { id: seed.agents[0].auditId, scope: "user", project_id: null, actor_kind: "human",
    actor_member_id: null, actor_name: seed.actor.name, action: "configuration.takeover", target_kind: "agent", target_id: "a", target_name: String(agent.display_name),
    changed: originCanonical(["configuration_authority"]), before: originCanonical({ owner: "legacy" }),
    after: originCanonical({ owner: "profile", activationId: seed.activationId, profileRevision: 1 }),
    detail: originCanonical({ contract: "m2-takeover-audit/r1", planId: seed.planId, captureId: seed.captureId, sourceIdentityDigest: source.identityDigest }),
    reversed_at: null, reversed_by_audit_id: null, created_at: seed.createdAt };
  const auditColumns = table("audit_log").columns;
  assert.deepEqual(Object.keys(auditValues).sort(), [...auditColumns].sort());
  const auditAdditions = { table: "audit_log", columns: auditColumns, rows: [{ rowid: "31", cells: auditColumns.map(c => originCell(auditValues[c]!)) }], count: "1" };
  const rows = { contract: "m2-transformed-business-rows/r1", source, newTables, executionReferences, auditAdditions };
  const targetRowsDigest = originDigest(["m2-transformed-business-rows/r1", source, newTables, executionReferences, auditAdditions]);
  const target = { contract: "m2-target-rows-manifest/r1", source, seed: store.refs.seed, capture: captureRef, rows, targetRowsDigest };
  const targetArtifact = store.add("target", "m2-target-rows", target, [store.refs.seed!, captureArtifact, p0.refs.physical, p0.refs.receipt, ...(advanced?.dependencies ?? [])]);
  const locator = (name: string) => { const t = table(name), keys = M2_HISTORY_TABLES.find(f => f.name === name)!.primaryKey;
    return { table: name, key: keys.map(column => ({ column, cell: t.rows[0]!.cells[t.columns.indexOf(column)]! })) }; };
  const cell = (name: string, column: string) => { const t = table(name), key = locator(name).key;
    return { row: { table: name, key }, column,
      cellDigest: originDigest(["m2-source-cell/r1", captureRef.artifactDigest, name, key, column, t.rows[0]!.cells[t.columns.indexOf(column)]]) }; };
  const slot = (kind: string, inputs: [string, string][]) => { const s = snapshot(kind); return { state: "present", legacyRef: s.origin.legacyRef,
    rawInputs: inputs.map(([name, column]) => cell(name, column)), snapshotRef: s.ref,
    workspace: advanced?.workspaces.get(kind) ?? { state: "blocked", reasons: ["workspace_reference_missing"] } }; };
  const map = { contract: "m2-source-to-target-manifest/r1", source, planId: seed.planId, seed: store.refs.seed,
    capture: captureRef, targetRows: targetArtifact,
    profiles: [{ agent: locator("agents"), runtime: locator("agent_runtimes"), alias: locator("agent_legacy_aliases"), profile: profile.ref,
      compatRuntimeRevision: Number(runtime.revision) }],
    bindings: [{ groupParticipant: locator("group_participants"), member: locator("members"), group: locator("groups"), project: locator("projects"),
      execution: locator("agent_runtime_bindings"), runner: locator("agent_runner_states"), binding: binding.ref, agentId: "a",
      requested: slot("requestedSnapshot", [["agent_runtime_bindings", "requested_snapshot_json"], ["agent_runtime_bindings", "advanced_json"], ["agent_runtimes", "config_version"], ["agents", "host_type"]]),
      applied: slot("applied", [["agent_runner_states", "applied_json"], ["agent_runtime_bindings", "advanced_json"], ["agent_runtimes", "config_version"], ["agents", "host_type"]]),
      effective: slot("effective", [["agent_runtimes", "defaults_json"], ["agent_runtime_bindings", "overrides_json"], ["agent_runtime_bindings", "advanced_json"],
        ["agent_runtimes", "revision"], ["agent_runtime_bindings", "revision"], ["agents", "host_type"], ["agent_runtimes", "config_version"]]),
      selectedKind: "requestedSnapshot", advancedRule: advanced ? "legacy-equivalence" : "none", advancedEvidence: advanced?.equivalence ?? null }], auditIds: [seed.agents[0].auditId],
    selectionRule: "requested-then-applied-then-captured-effective-no-invalid-fallback/r1" };
  const mapArtifact = store.add("sourceToTarget", "m2-source-to-target", map, [store.refs.seed!, captureArtifact, targetArtifact, ...(advanced?.dependencies ?? [])]);
  return { capture, captureRef, captureArtifact, profile, binding, snapshots, projections, rows, target, targetArtifact, map, mapArtifact };
}

export function originApplyBusiness(tables: RawTable[], oldTables: RawTable[], rows: ReturnType<typeof originBusiness>["rows"]): void {
  for (const target of tables) {
    const old = oldTables.find(t => t.name === target.name);
    if (old) target.rows = old.rows.map(row => ({ rowid: row.rowid, cells: target.columns.map(column => {
      const index = old.columns.indexOf(column); return index < 0 ? ["null"] : structuredClone(row.cells[index]!);
    }) }));
    const created = rows.newTables.find(t => t.table === target.name);
    if (created) { assert.deepEqual(target.columns, created.columns); target.rows = structuredClone(created.rows); }
    const append = rows.executionReferences.find(t => t.table === target.name);
    if (append) for (const row of append.rows) {
      const existing = target.rows.find(old => old.rowid === row.rowid); assert(existing);
      for (const [index, column] of append.columns.entries()) existing.cells[target.columns.indexOf(column)] = structuredClone(row.cells[index]!);
    }
    if (target.name === "audit_log") target.rows.push(...structuredClone(rows.auditAdditions.rows));
    target.rows = originSortRows(target.rows); target.count = String(target.rows.length);
  }
}

import assert from "node:assert/strict";
import { canonicalJson, digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { buildM2Migration22ProfileValues } from "../../src/server/identity/m2-migration-values.ts";
import { M2_PROFILE_WRITER_CONTRACT } from "../../src/server/identity/internal/m2-profile-writer-contract.ts";
import type { HistoryObservationInput, RawCell } from "../../src/server/identity/m2-history-contracts.ts";
import type { ArtifactRef } from "../../src/server/identity/m2-value-contracts.ts";
import { m2OriginP0Fixture } from "./m2-origin-fixture-p0.ts";
import { originOwnerSuccessors } from "./m2-origin-fixture-owner.ts";
import { originContractSources } from "./m2-origin-fixture-contracts.ts";
import { originBusiness, originApplyBusiness, originEncode, originProjectionRow, originSortRows } from "./m2-origin-fixture-business.ts";
import { originP1Tables, originHistorySelection, originSelectionDependencies, originControl, originDomain } from "./m2-origin-fixture-history.ts";
import { ORIGIN_TIME, originAnchor, originCanonical, originDigest, originEvidence, originRow, originSet, originSha } from "./m2-origin-fixture-store.ts";
import type { OriginChange } from "./m2-origin-fixture-store.ts";

export type OriginFixtureOptions = { change?: OriginChange; pageSize?: 512 | 1024 | 4096; ownerCount?: 0 | 1 | 2; advancedWorkspace?: boolean };
/** Real nonempty captured SQLite rows and a complete pure-value M2 origin graph.
 * No native migration, restore, publication, registration or admission is claimed.
 * The default branch preserves the original zero-owner bytes. Optional owner
 * successors replay from the captured original v1 history through A and B. */
export async function m2OriginFixture(options: OriginFixtureOptions = {}) {
  const ownerCount = options.ownerCount ?? 0; assert([0, 1, 2].includes(ownerCount));
  const p0 = await m2OriginP0Fixture(options.change, { pageSize: options.pageSize ?? 512, includeHistoricalClient: ownerCount > 0, advancedWorkspace: options.advancedWorkspace ?? false }),
    { store, before, preA } = p0, source = before.source;
  const sources = originContractSources(), sourceRefs: Record<string, ArtifactRef> = {};
  for (const item of sources) sourceRefs[item.name] = store.raw("contract:" + item.name, item.kind,
    Buffer.from(item.bytesHex, "hex"), item.artifact);
  const fixed = (name: string) => { const ref = sourceRefs[name]; assert(ref, name); return ref; };
  const universe = JSON.parse(Buffer.from(sources.find(s => s.name === "PC-TABLE-UNIVERSE.json")!.bytesHex, "hex").toString("utf8"));
  const ev = (label: string) => originEvidence(store.refs[label]!, store.value(label));
  const beforeSelection = originHistorySelection(store, "before", before);
  const seed = { contract: "m2-takeover-seed/r1", source, migrationId: "a12", s4Plan: p0.refs.plan,
    requestId: "origin-request", planId: "origin-plan", activationId: "origin-activation", captureId: "origin-capture",
    before: beforeSelection, createdAt: ORIGIN_TIME, actor: { kind: "human", name: "Origin fixture", memberId: null },
    agents: [{ agentId: "a", profileRevision: 1, auditId: "origin-takeover-audit" }],
    bindings: [{ memberId: "m", groupId: "g", groupBindingId: "b", bindingRevision: 1, legacyExecutionId: "b",
      effective: { snapshotId: "origin-effective", mappingId: options.advancedWorkspace ? "origin-mapping-effective" : null },
      requested: { snapshotId: "origin-requested", mappingId: options.advancedWorkspace ? "origin-mapping-requested" : null },
      applied: { snapshotId: "origin-applied", mappingId: options.advancedWorkspace ? "origin-mapping-applied" : null } }] };
  const seedArtifact = store.add("seed", "m2-takeover-seed", seed, [p0.refs.plan, ...originSelectionDependencies(beforeSelection)]);
  const business = originBusiness(p0, seed, options.advancedWorkspace);
  const migrationResult = buildM2Migration22ProfileValues(JSON.stringify({ backend: "sqlite", seed,
    profileFormatPair: M2_PROFILE_WRITER_CONTRACT.profileFormatPair }));
  assert(migrationResult.ok, JSON.stringify(migrationResult));
  const migration = migrationResult.value.migration;
  const migrationArtifact = store.add("migration22", "m2-migration22-entry", migration.entry, [fixed("CONTROLLED-MIGRATION-DEFINITION.json")]);
  const oldControl = originRow(before.tables.find(t => t.name === "storage_maintenance")!);
  const schemaBeforeDigest = p0.manifests.schemaManifestDigest, guardBeforeDigest = String(oldControl.guard_manifest_digest);
  // Independent original S1/G1 domains, deliberately labelled as fixture values.
  // These are neither catalog/source-file hashes nor observations of installed native schema/guards.
  const schemaAfterDigest = originSha("fixture-only M2 native-schema domain; installation unproven"),
    guardAfterDigest = originSha("fixture-only M2 native-guard domain; installation unproven");
  const pair = M2_PROFILE_WRITER_CONTRACT.profileFormatPair;
  const upgrade = { contract: "m2-registered-upgrade-descriptor/r1", schemaMigration: 22, configFormat: 1,
    protocolBefore: 1, protocolAfter: 2, writerFormat: "s2-profile-config/v1", writerFormatDigest: pair.writerFormatDigest,
    sourceBackend: "sqlite", schemaBeforeDigest, schemaAfterDigest, guardBeforeDigest, guardAfterDigest,
    sqliteTargetSchemaRef: fixed("PHYSICAL-RELATIONS.md"), postgresTargetSchemaRef: fixed("PHYSICAL-RELATIONS.md"),
    guardTransitionRef: fixed("S4-M2-TRANSITION-6829646852.md"), strictDecoderContractRef: fixed("PHYSICAL-DESIGN.md"),
    sourceClientFormatContractRef: fixed("SOURCE-CLIENT-FORMAT-CONTRACT.json") };
  const upgradeArtifact = store.add("upgrade", "m2-upgrade-descriptor", upgrade,
    [upgrade.sqliteTargetSchemaRef, upgrade.postgresTargetSchemaRef, upgrade.guardTransitionRef, upgrade.strictDecoderContractRef, upgrade.sourceClientFormatContractRef]);
  const guardTransition = { protocolBefore: 1, protocolAfter: 2, guardBeforeDigest, guardAfterDigest,
    schemaBeforeDigest, schemaAfterDigest, writerFormat: "s2-profile-config/v1", writerFormatDigest: pair.writerFormatDigest,
    registeredUpgrade: ev("upgrade") };
  const preAControl = originControl(store, "preAControl", preA, p0.refs.preA);
  const delta = { contract: "m2-allowed-delta-manifest/r1", mode: "legacy-to-local-profile-a", source, planId: seed.planId,
    seed: seedArtifact, before: beforeSelection, targetRows: business.targetArtifact, sourceToTarget: ev("sourceToTarget"), upgrade: ev("upgrade"),
    schemaBefore: fixed("PC-TABLE-UNIVERSE.json"), schemaAfter: fixed("PC-TABLE-UNIVERSE.json"),
    oldColumnsRule: "preserve-all-615-native-cells-and-sqlite-rowids/r1", auditRule: "one-configuration-takeover-per-agent/r1",
    executionRule: "append-fixed-six-and-two-only/r1", migrationRule: { version: 22, entry: migrationArtifact, sequenceBefore: null, sequenceAfter: null },
    controlRule: { kind: "m2-a-exact-control-transition/r1", before: ev("preAControl"), coordinatorClientId: "origin-coordinator", terminal: null, anchor: "SELF_J_A" },
    receiptRule: "derive-pa-receipt-after-plan/r1", authorityRule: "exact-local-profile-from-derived-receipt/r1" };
  const deltaArtifact = store.add("delta", "m2-allowed-delta", delta, [seedArtifact, ...originSelectionDependencies(beforeSelection), business.targetArtifact,
    business.mapArtifact, upgradeArtifact, fixed("PC-TABLE-UNIVERSE.json"), migrationArtifact, preAControl.artifact]);
  const takeover = { contract: "m2-takeover-plan/r1", planId: seed.planId, requestId: seed.requestId, activationId: seed.activationId,
    source, migrationId: seed.migrationId, s4Plan: p0.refs.plan, seed: seedArtifact, physicalSourceRef: before.physicalSourceRef,
    snapshotReceiptRef: before.snapshotReceiptRef, captureRef: business.captureRef, guardTransition,
    allowedDeltaManifest: ev("delta"), sourceToTargetManifest: ev("sourceToTarget"), targetRowsDigest: business.target.targetRowsDigest,
    expectedAuthority: "legacy" };
  const takeoverArtifact = store.add("takeover", "m2-takeover-plan", takeover, [p0.refs.plan, seedArtifact, p0.refs.physical,
    p0.refs.receipt, business.captureArtifact, upgradeArtifact, deltaArtifact, business.mapArtifact]);
  const takeoverPlan = { planId: seed.planId, digest: originDigest(store.value("takeover")) };
  const receiptBody = { requestId: seed.requestId, planRef: takeoverPlan, physicalSourceRef: before.physicalSourceRef,
    snapshotReceiptRef: before.snapshotReceiptRef, captureRef: business.captureRef, schemaBeforeDigest, schemaAfterDigest,
    guardTransition, allowedDeltaManifest: ev("delta"), targetRowsDigest: business.target.targetRowsDigest,
    sourceToTargetManifest: ev("sourceToTarget"), committedAuthority: "profile" };
  const receipt = { ref: { activationId: seed.activationId, digest: originDigest(receiptBody) }, ...receiptBody };
  const receiptArtifact = store.add("activationReceipt", "m2-activation-receipt", receipt,
    [takeoverArtifact, p0.refs.physical, p0.refs.receipt, business.captureArtifact, upgradeArtifact, deltaArtifact, business.mapArtifact]);
  const authority = { singleton: 1, formatVersion: 1, owner: "profile", activationId: seed.activationId,
    sourceBinding: { contract: "m2-source-binding/r1", kind: "local", physicalSourceRef: before.physicalSourceRef, activation: receipt.ref } };
  const authorityProjection = originEncode("config_authority", authority), receiptProjection = originEncode("config_activation_receipts", receipt);
  const requestDigestA = digestJson({ operation: "commit-profile-takeover", source, takeoverPlan, requestId: seed.requestId });
  const common = { activation: receipt.ref, takeoverPlan, physicalSource: before.physicalSourceRef, migrationId: seed.migrationId,
    s4PlanDigest: p0.refs.plan.sha256, ownerGeneration: 7 };
  const recordA = { formatVersion: 4, kind: "journal", migrationId: seed.migrationId, sequence: 6, previous: p0.refs.preA,
    source, plan: p0.refs.plan, requestId: seed.requestId, requestDigest: requestDigestA, fenceEpoch: 2, ownerGeneration: 7,
    event: "s2_profile_committed", phase: "s2_profile_committed", body: { formatVersion: 1, ...common,
      eventKind: "s2_profile_committed", phase: "s2_profile_committed", requestDigest: requestDigestA,
      predecessor: originAnchor(p0.refs.preA, 5), fenceEpoch: 2, guardTransition, exactAllowedDelta: ev("delta"), plannedTargetManifest: ev("target"),
      after: { admission: "sealed", journal: "SELF", terminal: null } }, bindings: { activationReceipt: receiptArtifact, takeoverPlan: takeoverArtifact } };
  const journalA = store.add("J_A", "journal", recordA,
    [p0.refs.preA, p0.refs.plan, p0.refs.physical, receiptArtifact, takeoverArtifact, upgradeArtifact, deltaArtifact, business.targetArtifact], "legacy");
  const tables = originP1Tables(store, universe);
  originApplyBusiness(tables, preA.tables, business.rows);
  const at = (name: string) => tables.find(t => t.name === name)!;
  for (const projection of [authorityProjection, receiptProjection]) {
    const table = at(projection.table); table.rows = [originProjectionRow(projection, table.columns, "1")]; table.count = "1";
  }
  at("schema_migrations").rows.push({ rowid: migration.row.rowid, cells: migration.row.cells.map(cell => [...cell] as RawCell) });
  at("schema_migrations").rows = originSortRows(at("schema_migrations").rows); at("schema_migrations").count = "22";
  originSet(at("storage_maintenance"), "protocol_version", 2); originSet(at("storage_maintenance"), "guard_manifest_digest", guardAfterDigest);
  originSet(at("storage_maintenance"), "journal_record_ref", journalA.ref); originSet(at("storage_maintenance"), "journal_digest", journalA.sha256);
  originSet(at("storage_maintenance"), "journal_sequence", 6);
  const coordinatorIndex = at("storage_source_clients").rows.findIndex((_, i) => originRow(at("storage_source_clients"), i).client_id === "origin-coordinator");
  assert(coordinatorIndex >= 0);
  originSet(at("storage_source_clients"), "protocol_version", 2, coordinatorIndex);
  originSet(at("storage_source_clients"), "writer_format_digest", pair.writerFormatDigest, coordinatorIndex);
  const oldCatalog = store.value("catalog:p0");
  const catalogBody = { ...oldCatalog, phase: "p1", tables: tables.map(t => ({ name: t.name, columnContract: t.columnContract,
    columnContractValueDigest: t.columnContractValueDigest })), migrations: [...oldCatalog.migrations,
      { version: 22, name: migration.entry.name, checksum: migration.entry.checksum }] };
  const catalog = store.add("catalog:p1", "pc-catalog", catalogBody, tables.map(t => t.columnContract), "raw");
  const afterA: HistoryObservationInput = { ...structuredClone(before), phase: "p1", tables, catalog };
  const owners = originOwnerSuccessors({ p0, afterA, journalA, count: ownerCount, logicalCatalog: fixed("PC-TABLE-UNIVERSE.json"),
    receiptArtifact, takeoverArtifact, receipt, takeoverPlan });
  const { preB, previous: latestJournal, sequence: latestSequence, generation: latestGeneration } = owners;
  const completedCommon = { ...common, ownerGeneration: latestGeneration }, completionSequence = latestSequence + 1;
  const rowDependencies = { legacy_config_captures: [business.captureArtifact, p0.refs.physical, p0.refs.receipt],
    config_snapshots: [business.captureArtifact], config_activation_receipts: [receiptArtifact, takeoverArtifact, p0.refs.physical,
      p0.refs.receipt, business.captureArtifact, upgradeArtifact, deltaArtifact, business.mapArtifact],
    config_authority: [p0.refs.physical, receiptArtifact], storage_maintenance: [latestJournal] };
  const preBSelection = originHistorySelection(store, "preB", preB, rowDependencies);
  const exact = { contract: "m2-exact-delta-check/r1", source, before: beforeSelection, after: preBSelection,
    allowedDelta: ev("delta"), receipt: receiptArtifact, comparisonRule: "m2-a-full-72-table-postcondition/r1", targetRowsDigest: business.target.targetRowsDigest };
  const exactArtifact = store.add("exactDelta", "m2-exact-delta-check", exact,
    [...originSelectionDependencies(beforeSelection), ...originSelectionDependencies(preBSelection), deltaArtifact, receiptArtifact]);
  const full = originDomain(store, "domain:full", preBSelection, "full-data"), frozen = originDomain(store, "domain:frozen", preBSelection, "frozen-business"),
    controls = originDomain(store, "domain:controls", preBSelection, "pre-anchor-controls"), clients = originDomain(store, "domain:clients", preBSelection, "source-clients");
  const proof = { ...completedCommon, predecessor: originAnchor(latestJournal, latestSequence), fenceEpoch: 2, protocolVersion: 2,
    guardDigest: guardAfterDigest, schemaDigest: schemaAfterDigest, frozenBusinessManifest: ev("domain:frozen"), preAnchorControlManifest: ev("domain:controls"),
    sourceClientsManifest: ev("domain:clients"), fullDataBeforeB: ev("domain:full"), sourceFilesManifest: { artifactId: p0.refs.files.ref, digest: p0.refs.files.sha256 },
    exactAllowedDeltaCheck: ev("exactDelta") };
  const proofArtifact = store.add("proof", "m2-post-a-proof", proof,
    [p0.refs.physical, latestJournal, frozen.artifact, controls.artifact, clients.artifact, full.artifact, p0.refs.files, exactArtifact]);
  const requestDigestB = digestJson({ operation: "finish-profile-takeover", source, activation: receipt.ref, takeoverPlan,
    migrationId: seed.migrationId, s4PlanDigest: p0.refs.plan.sha256 });
  const recordB = { formatVersion: 4, kind: "journal", migrationId: seed.migrationId, sequence: completionSequence, previous: latestJournal, source,
    plan: p0.refs.plan, requestId: seed.requestId + ":finish", requestDigest: requestDigestB, fenceEpoch: 2, ownerGeneration: latestGeneration,
    event: "s2_profile_completed", phase: "s2_profile_completed", body: { formatVersion: 1, ...completedCommon,
      eventKind: "s2_profile_completed", phase: "s2_profile_completed", requestDigest: requestDigestB, predecessor: originAnchor(latestJournal, latestSequence),
      fenceEpochBefore: 2, sealedProof: ev("proof"), after: { admission: "open", fenceEpoch: 3, activeMigrationId: null, planDigest: null,
        ownerGeneration: latestGeneration, protocolVersion: 2, guardDigest: guardAfterDigest, journal: "SELF", completionBinding: "SELF_BINDING" } },
    bindings: { activationReceipt: receiptArtifact, takeoverPlan: takeoverArtifact } };
  const journalB = store.add("J_B", "journal", recordB, [latestJournal, p0.refs.plan, p0.refs.physical, receiptArtifact, takeoverArtifact, proofArtifact], "legacy");
  const completion = { activation: receipt.ref, takeoverPlan, migrationId: seed.migrationId, s4PlanDigest: p0.refs.plan.sha256,
    sourceIdentityDigest: source.identityDigest, epochBefore: 2, epochAfter: 3, terminal: originAnchor(journalB, completionSequence) };
  const afterB = structuredClone(preB), current = afterB.tables.find(t => t.name === "storage_maintenance")!;
  originSet(current, "admission", "open"); originSet(current, "fence_epoch", 3); originSet(current, "active_migration_id", null); originSet(current, "plan_digest", null);
  originSet(current, "journal_record_ref", journalB.ref); originSet(current, "journal_digest", journalB.sha256); originSet(current, "journal_sequence", completionSequence);
  originSet(current, "profile_takeover_terminal_json", canonicalJson(completion));
  const nodes = [p0.refs.enter, p0.refs.capture, p0.refs.ready, store.refs.bridge!, p0.refs.preA, journalA, ...owners.steps.map(step => step.journal), journalB];
  const closureValue = { contract: "profile-journal-closure/r1", purpose: "m2-origin", originSource: source,
    migrationId: seed.migrationId, plan: p0.refs.plan, genesis: p0.refs.enter, nodes, terminal: journalB, originHistory: null };
  const closure = store.add("closure", "profile-journal-closure", closureValue, [p0.refs.plan, ...nodes]);
  const authorityTable = afterB.tables.find(t => t.name === "config_authority")!;
  const authorityRow = { contract: "m2-pc-typed-row/r1", source, backend: "sqlite", phase: "p1", table: "config_authority",
    columnContract: authorityTable.columnContract, columnContractValueDigest: authorityTable.columnContractValueDigest, row: authorityTable.rows[0] };
  const authorityArtifact = store.add("authorityRow", "pc-typed-row", authorityRow, [authorityTable.columnContract, p0.refs.physical, receiptArtifact], "raw");
  const historyValue = { contract: "profile-origin-history-value/r1", source, authorityRow: authorityArtifact,
    activation: receipt.ref, activationReceipt: receiptArtifact, completion, journalClosure: closure };
  const historyArtifact = store.add("history", "profile-origin-history", historyValue, [authorityArtifact, receiptArtifact, closure, journalB]);
  const durableInput = { contract: "m2-durable-validation/r2", roots: { kind: "m2-origin", closure }, selectedArtifacts: store.reachable([closure]) };
  const pcInput = { contract: "m2-history-closure-input/r2", graph: { kind: "m2-observation", observation: afterB,
    origin: { sourceHistory: historyArtifact, importManifest: null } }, artifacts: store.reachable([historyArtifact, catalog, p0.refs.physical, p0.refs.receipt]),
    evidence: p0.oldInput.evidence, proposedDeletion: null };
  return { durableInput, durableWire: originCanonical(durableInput), pcInput, before, captureObservation: before, preA, afterA, preB, afterB,
    refs: { ...store.refs }, selected: store.all(), store, seed, beforeSelection, preBSelection, sources,
    oldInput: p0.oldInput, projections: [...business.projections, authorityProjection, receiptProjection], snapshots: business.snapshots,
    business, receipt, completion, history: historyValue, schemaAfterDigest, guardAfterDigest, owners: owners.steps,
    unverified: ["native-source-identity", "native-schema-guard-installation", "native-backup-restore", "native-A-B-commit", "native-publication",
      "production-registration", "current-admission", ownerCount === 0 ? "after-A-owner-CF17" : "complete-origin-owner-consumer"] };
}

/** Rebuild content addresses from a producer-stage mutation. It intentionally does
 * not repair the mutated semantic claim, so strict consumers must still reject it. */
export function reanchorM2OriginFixture(change: OriginChange) { return m2OriginFixture({ change }); }

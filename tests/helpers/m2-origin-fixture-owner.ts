import assert from "node:assert/strict";
import { canonicalJson, digestJson } from "../../src/server/storage/maintenance/canonical.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../../src/server/storage/maintenance/manifests.ts";
import type { Json } from "../../src/server/storage/maintenance/types.ts";
import type { HistoryObservationInput, RawRow, RawTable } from "../../src/server/identity/m2-history-contracts.ts";
import type { ArtifactRef } from "../../src/server/identity/m2-value-contracts.ts";
import type { m2OriginP0Fixture } from "./m2-origin-fixture-p0.ts";
import { originControl, originTypedTable } from "./m2-origin-fixture-history.ts";
import { OriginStore, originCell, originEvidence, originRawValue, originRow, originSet, originSha } from "./m2-origin-fixture-store.ts";

type P0 = Awaited<ReturnType<typeof m2OriginP0Fixture>>;
type OwnerInput = { p0: P0; afterA: HistoryObservationInput; journalA: ArtifactRef; count: 0 | 1 | 2;
  logicalCatalog: ArtifactRef; receiptArtifact: ArtifactRef; takeoverArtifact: ArtifactRef;
  receipt: { ref: { activationId: string; digest: string }; guardTransition: { writerFormatDigest: string } };
  takeoverPlan: { planId: string; digest: string } };
export type OriginOwnerStep = { ordinal: number; before: HistoryObservationInput; after: HistoryObservationInput;
  journal: ArtifactRef; facts: ArtifactRef; delta: ArtifactRef; runtimeCut: ArtifactRef; controlBefore: ArtifactRef };

const clientKey = (row: RawRow) => row.cells[0]![1]!;
const ordered = (rows: RawRow[]) => [...rows].sort((a, b) => Buffer.compare(Buffer.from(clientKey(a)), Buffer.from(clientKey(b))));
const tableAt = (observation: HistoryObservationInput, name: string) => {
  const table = observation.tables.find(t => t.name === name); assert(table, name); return table;
};

/** Preserve all 72 raw tables and native manifest formulas. This metadata is a
 * value fixture, not an observation of installed schema or native owner access. */
function runtimeCut(store: OriginStore, label: string, current: HistoryObservationInput,
  predecessor: ArtifactRef, logicalCatalog: ArtifactRef): ArtifactRef {
  const tables = current.tables.map(table => {
    const contract = store.entries.get(table.columnContract.ref)!.value;
    const columns = contract.columns.map((column: any, i: number) => ({ cid: String(i), name: column.name, type: column.declaredType,
      notnull: column.nullable ? "0" : "1", dflt_value: column.defaultExpression, pk: String(column.primaryKeyOrdinal), hidden: String(column.hidden) }));
    const rows = table.rows.map(row => row.cells.map(cell => cell[0] === "real64be" ? ["real-ieee754", cell[1]] : cell)) as Json[];
    return { name: table.name, columns, ...digestRowMultiset(rows) };
  });
  const controlRows = (name: string) => {
    const table = tableAt(current, name), rows = name === "storage_source_clients" ? ordered(table.rows) : table.rows;
    return rows.map(row => Object.fromEntries(Object.entries(originRow({ ...table, rows: [row], count: "1" }))
      .map(([key, value]) => [key, typeof value === "bigint" ? String(value) : value])) as Record<string, Json>);
  };
  const manifests = buildDatabaseManifests("sqlite", { kind: "origin-owner-value-catalog-not-native-installation" }, tables,
    { storage_maintenance: controlRows("storage_maintenance"), storage_source_clients: controlRows("storage_source_clients") });
  const physicalCatalog = store.add(label + ":physicalCatalog", "database-manifests", manifests, [], "legacy");
  const cut = { contract: "s4p-row-cut/r1", source: current.source, backend: "sqlite", stage: "p1-source",
    logicalCatalog, physicalCatalog, textEncoding: "UTF-8", predecessor,
    tables: current.tables.map(({ name, columns, count, rows }) => ({ name, columns, count, rows })), sequences: current.sequences };
  store.change?.(label + ":runtimeCut", cut);
  const bytes = Buffer.from(canonicalJson({ formatVersion: 1, kind: "s4p-row-cut", payload: cut })), sha256 = originSha(bytes);
  return store.raw(label + ":runtimeCut", "s4p-row-cut", bytes,
    { ref: `s4-provider/sha256/${sha256}/s4p-row-cut.json`, sha256, bytes: String(bytes.length) },
    [logicalCatalog, physicalCatalog, predecessor], cut);
}

/** Complete fixture history: each predecessor is the prior actual journal, and
 * each before cut is derived from that event's full after state. No pre-replayed
 * roster, registration map, validator result or native capability is injected. */
export function originOwnerSuccessors(input: OwnerInput) {
  const { p0, receipt, receiptArtifact, takeoverArtifact, takeoverPlan } = input, { store } = p0;
  let current = structuredClone(input.afterA), previous = input.journalA, sequence = 6, generation = 7;
  const steps: OriginOwnerStep[] = [];
  const source = current.source, originalFacts = store.value("preA").controlProof.facts;
  for (let ordinal = 1; ordinal <= input.count; ordinal++) {
    const label = "owner:" + ordinal, before = structuredClone(current), clients = tableAt(before, "storage_source_clients");
    const observedAt = `2026-11-19T00:0${ordinal}:00.000Z`, actorId = ordinal === 1
      ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const actor = { actorId, clientId: null, host: structuredClone(originalFacts.actor.host),
      process: { ...originalFacts.actor.process, instanceId: actorId, pid: 124 + ordinal, startTicks: String(900 + ordinal) },
      processCheck: { ...originalFacts.actor.processCheck, pid: 124 + ordinal, startTicksBefore: String(900 + ordinal), startTicksAfter: String(900 + ordinal) } };
    store.change?.(label + ":actor", actor);
    const transition = { fromGeneration: generation, toGeneration: generation + 1, targetSequence: sequence + 1, previousAnchor: previous };
    store.change?.(label + ":transition", transition);
    const encoding = { backend: "sqlite", name: "UTF-8" } as const;
    const rowDigest = (row: RawRow) => digestJson(["profile-source-client-row/r2", source, encoding,
      clients.columnContract, clients.columnContractValueDigest, [row.rowid, row.cells]]);
    const rowsDigest = (rows: RawRow[]) => digestJson(["profile-source-clients-live-rows/r2", source, encoding,
      clients.columnContract, clients.columnContractValueDigest, String(rows.length), ordered(rows).map(row => [row.rowid, row.cells])]);
    const clientFacts = ordered(clients.rows).map(row => {
      const values = originRow({ ...clients, rows: [row], count: "1" }), host = JSON.parse(String(values.host_identity_json)),
        process = JSON.parse(String(values.process_identity_json));
      const common = { subject: row.cells[0], rowDigest: rowDigest(row), host, process,
        processCheck: { kind: "linux-absent", observerUid: 1000, kernelBootId: process.kernelBootId,
          pidNamespace: process.pidNamespace, pid: process.pid, stage: "proc-open", errno: "ENOENT" } };
      return values.entrypoint === "maintenance-controller"
        ? { ...common, kind: "maintenance-controller", classification: "exited-actor", registration: "current-chain" }
        : { ...common, kind: "ordinary-client", classification: "historical-client", receipt: null };
    });
    const sessions = structuredClone(originalFacts.sessions);
    sessions.observer = { host: actor.host, process: actor.process };
    // Nonempty, internally matched synthetic value evidence. No real process or
    // FD is claimed; the original refinements still verify the complete joins.
    const resource = { key: "fd:" + (40 + ordinal), device: "1", inode: "2" };
    sessions.ownedResources = [resource];
    sessions.matches = [{ ...resource, pid: actor.process.pid, startTicks: actor.process.startTicks, sourceRole: "main" }];
    const runtime = structuredClone(p0.runtimeFacts);
    for (const runner of runtime.runners) runner.inspection.inspectedAt = observedAt;
    const observation = { formatVersion: 2, kind: "profile-source-control-event-facts", collector: "boardroom-profile-control-facts-v2",
      observedAt, actor, beforeCount: clients.count, beforeRowsDigest: rowsDigest(clients.rows), clients: clientFacts, runtime, sessions };
    const currentFormat = { kind: "m2-profile", activationReceipt: receiptArtifact, protocolVersion: 2,
      writerFormatDigest: receipt.guardTransition.writerFormatDigest };
    const context = { source, migrationId: "a12", plan: p0.refs.plan, event: "s2_profile_owner_acquired", phase: "s2_profile_committed",
      epochBefore: 2, epochAfter: 2, ...transition, originCapture: p0.refs.capture, receiptGeneration: 7, currentFormat };
    store.change?.(label + ":context", context);
    const creation = { migrationId: "a12", plan: p0.refs.plan, fenceEpoch: "2", ownerGeneration: String(transition.toGeneration),
      previousAnchor: transition.previousAnchor, targetSequence: String(transition.targetSequence) };
    const registration = { formatVersion: 2, kind: "profile-maintenance-controller-registration", source, sourceIdentityDigest: source.identityDigest,
      creation, writerFormat: { protocolVersion: 2, writerFormatDigest: currentFormat.writerFormatDigest },
      sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
    const clientId = "后继-owner-" + ordinal;
    const newborn: RawRow = { rowid: String(91 + ordinal), cells: [clientId, source.databaseInstanceId, "maintenance-controller",
      "boardroom-maintenance-control-v1", 2, canonicalJson(actor.host), canonicalJson(actor.process), canonicalJson(registration),
      2, 2, null, "none", null, observedAt, observedAt, null, currentFormat.writerFormatDigest].map(originCell) };
    const changes: any[] = clients.rows.filter(row => originRawValue(row.cells[2]!) === "maintenance-controller" && row.cells[15]![0] === "null")
      .map(row => {
        const ended = structuredClone(row); ended.cells[14] = originCell(observedAt); ended.cells[15] = originCell(observedAt);
        return { kind: "client-observation", clientId: String(originRawValue(row.cells[0]!)), before: row, after: ended, effect: "ended-observed" };
      });
    changes.push({ kind: "maintenance-registration", clientId, before: null, after: newborn, actorId: actor.actorId });
    changes.sort((a, b) => Buffer.compare(Buffer.from(clientKey(a.after)), Buffer.from(clientKey(b.after))));
    store.change?.(label + ":changes", changes);
    const applied = new Map(clients.rows.map(row => [clientKey(row), row]));
    for (const change of changes) applied.set(clientKey(change.after), change.after);
    const afterTable: RawTable = { ...structuredClone(clients), rows: ordered([...applied.values()]), count: String(applied.size) };
    const beforeSelection = originTypedTable(store, label + ":before", before, clients),
      afterSelection = originTypedTable(store, label + ":after", before, afterTable);
    const control = originControl(store, label + ":controlBefore", before, previous, observedAt);
    const cut = runtimeCut(store, label, before, previous, input.logicalCatalog);
    const facts = { contract: "profile-source-client-facts/r2", context, textEncoding: encoding, columnContract: clients.columnContract,
      columnContractValueDigest: clients.columnContractValueDigest, before: beforeSelection, after: afterSelection,
      afterCount: afterTable.count, afterRowsDigest: rowsDigest(afterTable.rows), observation, runtimeCut: cut };
    const factsRef = store.add(label + ":facts", "m2-source-client-facts", facts,
      [p0.refs.plan, previous, p0.refs.capture, receiptArtifact, clients.columnContract, beforeSelection.typedRows, afterSelection.typedRows, cut]);
    const delta = { contract: "m2-source-client-delta/r2", source, before: beforeSelection, after: afterSelection,
      changes, facts: factsRef, rule: "profile-maintenance-only-registration-and-observation/r2" };
    const deltaRef = store.add(label + ":delta", "m2-source-client-delta", delta,
      [beforeSelection.typedRows, afterSelection.typedRows, factsRef]);
    const requestId = "origin-request:owner:" + ordinal;
    const journal = store.add("J_OWNER_" + ordinal, "journal", { formatVersion: 4, kind: "journal", migrationId: "a12",
      source, plan: p0.refs.plan, sequence: transition.targetSequence, previous, fenceEpoch: 2, ownerGeneration: transition.toGeneration,
      requestId, requestDigest: digestJson({ requestId, source, ...transition }), event: "s2_profile_owner_acquired", phase: "s2_profile_committed",
      body: { contract: "m2-profile-owner-acquired/r2", activation: receipt.ref, takeoverPlan, physicalSource: before.physicalSourceRef,
        fromGeneration: transition.fromGeneration, toGeneration: transition.toGeneration,
        controlBefore: originEvidence(control.artifact, store.value(label + ":controlBefore")),
        clientDelta: originEvidence(deltaRef, store.value(label + ":delta")),
        after: { admission: "sealed", protocolVersion: 2, journal: "SELF", terminal: null } },
      bindings: { activationReceipt: receiptArtifact, takeoverPlan: takeoverArtifact } },
      [previous, p0.refs.plan, p0.refs.physical, receiptArtifact, takeoverArtifact, control.artifact, deltaRef], "legacy");
    current = structuredClone(before);
    current.tables[current.tables.findIndex(table => table.name === "storage_source_clients")] = structuredClone(afterTable);
    const maintenance = tableAt(current, "storage_maintenance");
    originSet(maintenance, "owner_generation", transition.toGeneration); originSet(maintenance, "journal_record_ref", journal.ref);
    originSet(maintenance, "journal_digest", journal.sha256); originSet(maintenance, "journal_sequence", transition.targetSequence);
    steps.push({ ordinal, before, after: structuredClone(current), journal, facts: factsRef, delta: deltaRef, runtimeCut: cut, controlBefore: control.artifact });
    previous = journal; sequence = transition.targetSequence; generation = transition.toGeneration;
  }
  return { preB: current, steps, previous, sequence, generation };
}

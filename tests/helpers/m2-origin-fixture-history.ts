import assert from "node:assert/strict";
import { M2_HISTORY_TABLES } from "../../src/server/identity/m2-history-contracts.ts";
import type { HistoryObservationInput, RawTable } from "../../src/server/identity/m2-history-contracts.ts";
import type { ArtifactRef, SourceRef } from "../../src/server/identity/m2-value-contracts.ts";
import { OriginStore, ORIGIN_TIME, originDigest, originRow, originRowDigest } from "./m2-origin-fixture-store.ts";

export type OriginTableSelection = { table: string; columnContract: ArtifactRef; columnContractValueDigest: string;
  typedRows: ArtifactRef; count: string; rowMultisetDigest: string };
export type OriginHistorySelection = { contract: "m2-pc-typed-selection/r1"; source: SourceRef;
  backend: "sqlite" | "postgres"; phase: "p0" | "p1" | "p1-bootstrap"; observation: ArtifactRef;
  completeHistoryDigest: string; tables: OriginTableSelection[] };
export type OriginTableDependencies = Record<string, ArtifactRef[]>;

/** Build the selected column values from the fixed original universe, independently
 * of the product's schema checker. None of these values assert native DDL installation. */
export function originP1Tables(store: OriginStore, universe: any): RawTable[] {
  assert.equal(universe.counts.p1Tables, 72); assert.equal(universe.counts.p1Columns, 763);
  return M2_HISTORY_TABLES.map(fixed => {
    const original = universe.tables.find((t: any) => t.table === fixed.name); assert(original);
    assert.deepEqual(original.columnsP1.map((c: any) => c.name), fixed.columnsP1.map(c => c.name));
    const columns = original.columnsP1.map((c: any) => {
      const old = c.origin === "schema1-21", raw = c.sqlite;
      return { ordinal: c.ordinal, name: c.name, declaredType: raw.type,
        nullable: old ? raw.notnull === 0 : c.nullable,
        primaryKeyOrdinal: old ? raw.pk : Math.max(0, original.primaryKey.indexOf(c.name) + 1),
        hidden: old ? raw.hidden : 0, generated: null, identity: null,
        defaultExpression: old ? raw.dflt_value : raw.default ?? null,
        collation: old ? null : raw.collation ?? null };
    });
    const value = { contract: "m2-pc-column-contract/r1", backend: "sqlite", stage: "schema22", table: fixed.name,
      columns, rowid: "signed-int64" };
    const columnContract = store.add("column:p1:" + fixed.name, "pc-column-contract", value, [], "raw");
    return { name: fixed.name, columnContract, columnContractValueDigest: originDigest(value),
      columns: fixed.columnsP1.map(c => c.name), rows: [], count: "0" };
  });
}
export function originTypedTable(store: OriginStore, label: string, observation: HistoryObservationInput,
  table: RawTable, dependencies: ArtifactRef[] = []): OriginTableSelection {
  const rowMultisetDigest = originRowDigest(table, observation.backend);
  const payload = { contract: "m2-pc-typed-table/r1", backend: observation.backend, phase: observation.phase,
    source: observation.source, table, rowMultisetDigest };
  const typedRows = store.add(label + ":" + table.name, "pc-typed-table", payload, [table.columnContract, ...dependencies], "raw");
  return { table: table.name, columnContract: table.columnContract, columnContractValueDigest: table.columnContractValueDigest,
    typedRows, count: table.count, rowMultisetDigest };
}
export function originHistorySelection(store: OriginStore, label: string, observation: HistoryObservationInput,
  dependencies: OriginTableDependencies = {}): OriginHistorySelection {
  const tables = observation.tables.map(table => originTypedTable(store, label + ":table", observation, table, dependencies[table.name]));
  const evidence = [observation.physicalSourceRef, observation.snapshotReceiptRef].map(ref => {
    const entry = store.entries.get(ref.artifactId); assert(entry, ref.artifactId); return entry.selected.artifact;
  });
  const artifact = store.add(label + ":observation", "pc-observation", observation,
    [observation.catalog, ...observation.tables.map(t => t.columnContract), ...evidence, ...Object.values(dependencies).flat()], "raw");
  return { contract: "m2-pc-typed-selection/r1", source: observation.source, backend: observation.backend,
    phase: observation.phase, observation: artifact, completeHistoryDigest: originDigest(["m2-pc-complete-history/r1", observation]), tables };
}
export function originSelectionDependencies(selection: OriginHistorySelection): ArtifactRef[] {
  return [selection.observation, ...selection.tables.flatMap(t => [t.typedRows, t.columnContract])];
}
export function originControl(store: OriginStore, label: string, observation: HistoryObservationInput, journal: ArtifactRef, observedAt = ORIGIN_TIME) {
  const maintenance = observation.tables.find(t => t.name === "storage_maintenance")!, clients = observation.tables.find(t => t.name === "storage_source_clients")!;
  const raw = originRow(maintenance);
  const control = { singleton: 1, databaseInstanceId: raw.database_instance_id,
    controlRootJson: raw.control_root_json, mutexIdentityJson: raw.mutex_identity_json,
    fenceEpoch: Number(raw.fence_epoch), admission: raw.admission, activeMigrationId: raw.active_migration_id,
    planDigest: raw.plan_digest, protocolVersion: Number(raw.protocol_version), guardManifestDigest: raw.guard_manifest_digest,
    ownerGeneration: Number(raw.owner_generation), journal: raw.journal_record_ref === null ? null : {
      record: { artifactId: raw.journal_record_ref, digest: raw.journal_digest }, sequence: Number(raw.journal_sequence) },
    profileTakeoverTerminal: raw.profile_takeover_terminal_json == null ? null : JSON.parse(String(raw.profile_takeover_terminal_json)) };
  const maintenanceTable = originTypedTable(store, label + ":table", observation, maintenance, [journal]);
  const sourceClientsTable = originTypedTable(store, label + ":table", observation, clients);
  const value = { contract: "m2-control-observation/r1", source: observation.source, observedAt,
    control, maintenanceTable, sourceClientsTable };
  const artifact = store.add(label, "m2-control-observation", value, [maintenanceTable.typedRows, sourceClientsTable.typedRows, journal]);
  return { artifact, value };
}
export function originDomain(store: OriginStore, label: string, history: OriginHistorySelection,
  domain: "full-data" | "frozen-business" | "pre-anchor-controls" | "source-clients") {
  const tables = history.tables.filter(table => domain === "full-data" || domain === "source-clients" && table.table === "storage_source_clients"
    || domain === "pre-anchor-controls" && ["storage_maintenance", "storage_source_clients"].includes(table.table)
    || domain === "frozen-business" && !["storage_maintenance", "storage_source_clients", "schema_migrations"].includes(table.table));
  const value = { contract: "m2-observation-domain/r1", source: history.source, history, domain, tables,
    domainDigest: originDigest(["m2-observation-domain/r1", history.source, domain, tables]) };
  const artifact = store.add(label, "m2-observation-domain", value, originSelectionDependencies(history));
  return { artifact, value };
}

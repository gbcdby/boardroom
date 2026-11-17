import { canonicalJson } from "./canonical.ts";
import { decodeRow, supportedEncoding } from "./control-candidate/rows.ts";
import type { replayVerificationControls } from "./control-candidate/replay-core.ts";
import { MaintenanceFailure } from "./error.ts";
import type { JournalNode } from "./journal.ts";
import { digestRowMultiset } from "./manifests.ts";
import { encodePostgresCell } from "./postgres-manifests.ts";
import { sourceClientColumns } from "./source-clients-read.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import { sameSourceClientRow } from "./source-client-equality.ts";
import type { DatabaseManifests, Json, SourceClientRawRow, SourceClientsRosterV1, SourceLock, SourceObservation, VerificationJournalRecord } from "./types.ts";

type Replay = ReturnType<typeof replayVerificationControls>;
type Table = DatabaseManifests["tables"][number];
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireBinding(value: unknown): asserts value {
  if (!value) throw new MaintenanceFailure("source_changed", "v3-source-clients");
}
function decode(rows: readonly SourceClientRawRow[], encoding: SourceClientsRosterV1["textEncoding"]) {
  return rows.map(raw => {
    const row = decodeRow(raw, encoding);
    requireBinding(row !== null && sameSourceClientRow(row, row));
    return row;
  });
}
function sourceTable(manifests: DatabaseManifests): Table {
  const tables = manifests.tables.filter(table => table.name === "storage_source_clients");
  requireBinding(tables.length === 1);
  return tables[0]!;
}
function tableProfile(table: Table, kind: SourceObservation["source"]["kind"]): void {
  requireBinding(Array.isArray(table.columns) && table.columns.length === sourceClientColumns.length);
  for (const [index, expected] of sourceClientColumns.entries()) {
    const column = table.columns[index];
    requireBinding(column !== null && typeof column === "object" && !Array.isArray(column) && column.name === expected.name);
    requireBinding(kind === "sqlite"
      ? column.cid === String(index) && column.type === expected.sqlite
        && column.notnull === (expected.nullable || index === 0 ? "0" : "1")
      : column.position === String(index + 1) && column.type_oid === expected.postgres && column.not_null === !expected.nullable);
  }
}
/** Both representations are independently persisted. Neither controlRows alone nor
 * a matching table digest may stand in for the other. The native catalog supplies
 * the complete columns value; the fixed reader profile fixes its order and types. */
function bindRows(manifests: DatabaseManifests, rows: readonly SourceClientRawRow[], encoding: SourceClientsRosterV1["textEncoding"],
  columns: Json): void {
  const table = sourceTable(manifests), decoded = decode(rows, encoding), actual = manifests.controlRows.storage_source_clients;
  requireBinding(same(table.columns, columns) && actual.length === decoded.length);
  const indexed = new Map<string, Readonly<Record<string, Json>>>();
  for (const row of actual) {
    requireBinding(sameSourceClientRow(row, row) && typeof row.client_id === "string" && !indexed.has(row.client_id));
    indexed.set(row.client_id, row);
  }
  for (const row of decoded) {
    const found = indexed.get(row.client_id!);
    requireBinding(found && sameSourceClientRow(found, row));
  }
  const typedRows: Json[] = rows.map((raw, index) => sourceClientColumns.map(column => encoding.backend === "sqlite"
    ? [...raw[column.name]] : encodePostgresCell(column.postgres, decoded[index]![column.name])));
  const expected = digestRowMultiset(typedRows);
  requireBinding(table.count === expected.count && table.digest === expected.digest);
}
function exactInteger(value: Json | undefined, expected: string): boolean {
  return value === expected || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && String(value) === expected;
}
function bindCapturedMaintenance(archived: DatabaseManifests, capture: JournalNode<VerificationJournalRecord>, replay: Replay): void {
  const invariant = replay.captures.get(capture.reference.ref)?.invariant;
  requireBinding(invariant && archived.controlRows.storage_maintenance.length === 1);
  const row = archived.controlRows.storage_maintenance[0]!;
  const expected = { singleton: invariant.singleton, database_instance_id: invariant.databaseInstanceId,
    control_root_json: invariant.controlRootJson, mutex_identity_json: invariant.mutexIdentityJson, fence_epoch: invariant.fenceEpoch,
    admission: invariant.admission, active_migration_id: invariant.activeMigrationId, plan_digest: invariant.planDigest,
    protocol_version: invariant.protocolVersion, guard_manifest_digest: invariant.guardManifestDigest,
    owner_generation: String(capture.record.ownerGeneration), journal_record_ref: capture.reference.ref,
    journal_digest: capture.reference.sha256, journal_sequence: String(capture.record.sequence) };
  requireBinding(same(Object.keys(row).sort(), Object.keys(expected).sort()));
  const integers = new Set(["singleton", "fence_epoch", "owner_generation", "journal_sequence", "protocol_version"]);
  for (const [column, value] of Object.entries(expected))
    requireBinding(integers.has(column) ? exactInteger(row[column], value) : row[column] === value);
}

/** Internal V-only binding of an already parsed/replayed chain to the actual lock.
 * The replay result is data, not a permit. Unsupported encodings cannot be cleared
 * by a caller flag, a no-op chain, an empty table or the window's equality fast path.
 * Legacy capture uses its separate all-encoding native binding unchanged. */
export async function assertVerificationSourceClientBinding(lock: SourceLock, observed: SourceObservation,
  capture: JournalNode<VerificationJournalRecord>, archived: DatabaseManifests, replay: Replay) {
  const roster = replay.originalRoster, selected = replay.captures.get(capture.reference.ref);
  if (!supportedEncoding(roster.textEncoding) || replay.unresolvedEncoding.length !== 0)
    throw new MaintenanceFailure("source_changed", "v3-source-clients-encoding-unverified");
  requireBinding(capture.record.formatVersion === 3 && selected && capture.record.sourceClients !== null
    && same(capture.record.sourceClients, roster));
  await lock.assertHeld();
  const raw = await lock.observeSourceClients();
  requireBinding(same(raw.source, observed.source) && same(raw.sourceIdentity, observed.sourceIdentity)
    && same(raw.state, observed.state) && raw.schemaManifestDigest === observed.manifests.schemaManifestDigest
    && same(raw.source, roster.source) && same(raw.textEncoding, roster.textEncoding)
    && raw.textEncoding.backend === observed.source.kind && archived.dialect === observed.manifests.dialect
    && archived.dialect === observed.source.kind && archived.schemaManifestDigest === raw.schemaManifestDigest
    && roster.fenceEpoch === String(observed.state.fenceEpoch) && roster.migrationId === observed.state.activeMigrationId
    && roster.plan.sha256 === observed.state.planDigest);
  const actualRows = buildSourceClientsRoster({ ...roster, rows: raw.rows }).rows;
  requireBinding(same(actualRows, replay.expectedRows));
  const nativeTable = sourceTable(observed.manifests);
  tableProfile(nativeTable, observed.source.kind);
  bindRows(archived, selected.rows, roster.textEncoding, nativeTable.columns);
  bindRows(observed.manifests, replay.expectedRows, roster.textEncoding, nativeTable.columns);
  bindCapturedMaintenance(archived, capture, replay);
  await lock.assertHeld();
  // V's process window starts at the root, including controllers added before a
  // selected recapture; they still need their current native present/exit check.
  return decode(roster.rows, roster.textEncoding);
}

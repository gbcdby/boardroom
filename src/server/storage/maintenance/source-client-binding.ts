import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import type { DatabaseManifests, SourceClientsRosterV1, SourceLock, SourceObservation } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireBinding(value: unknown): asserts value {
  if (!value) throw new MaintenanceFailure("source_changed", "source-clients");
}

/** Complete the v2 capture/archive relationship through the caller's actual source lock.
 * The capture roster must come from the already verified selected journal node. Legacy
 * observation/takeover records carry no row changes, so its raw rows must remain exact.
 * The native manifest reader owns text conversion and typed-cell encoding on both
 * backends, including non-UTF8 PostgreSQL. No offline decoder or caller success flag
 * can replace this read. A finite B/U closure alone does not establish this relationship.
 */
export async function assertCapturedSourceClientBinding(lock: SourceLock, observed: SourceObservation,
  captured: SourceClientsRosterV1, archived: DatabaseManifests): Promise<void> {
  await lock.assertHeld();
  const raw = await lock.observeSourceClients();
  requireBinding(same(raw.source, observed.source) && same(raw.sourceIdentity, observed.sourceIdentity)
    && same(raw.state, observed.state) && raw.schemaManifestDigest === observed.manifests.schemaManifestDigest
    && same(raw.source, captured.source) && same(raw.textEncoding, captured.textEncoding)
    && raw.textEncoding.backend === observed.source.kind && archived.dialect === observed.manifests.dialect
    && archived.dialect === observed.source.kind && archived.schemaManifestDigest === raw.schemaManifestDigest
    && captured.fenceEpoch === String(observed.state.fenceEpoch) && captured.migrationId === observed.state.activeMigrationId
    && captured.plan.sha256 === observed.state.planDigest);
  requireBinding(same(buildSourceClientsRoster({ ...captured, source: raw.source, textEncoding: raw.textEncoding, rows: raw.rows }), captured));
  const expected = archived.tables.filter(table => table.name === "storage_source_clients");
  const current = observed.manifests.tables.filter(table => table.name === "storage_source_clients");
  requireBinding(expected.length === 1 && current.length === 1 && same(expected[0], current[0])
    && expected[0]!.count === String(archived.controlRows.storage_source_clients.length)
    && current[0]!.count === String(raw.rows.length)
    && same(archived.controlRows.storage_source_clients, observed.manifests.controlRows.storage_source_clients));
  await lock.assertHeld();
}

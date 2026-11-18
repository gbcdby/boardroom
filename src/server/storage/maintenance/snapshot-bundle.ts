import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, restorePointDigest, verifyJournalChain, verifyRestoreBundleClosure } from "./journal.ts";
import { buildDatabaseManifests } from "./manifests.ts";
import { ArtifactStore } from "./objects.ts";
import { parseManifests, readSourceFiles } from "./parse.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import { assertVerificationSourceClientBinding, replayConsumerSourceControls } from "./verification-source-client-binding.ts";
import type { ArtifactRef, BlockerCode, PublicationEvidence, RestoreBundleManifest, RestorePayloadRole, SourceLock, SourceObservation } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: BlockerCode): asserts value {
  if (!value) throw new MaintenanceFailure(code, "snapshot-bundle");
}

/**
 * Internal D/Md -> B/U production under a caller-owned, actual native snapshot lock.
 * Only the exact sealed DB anchor selects Jq. Existing Fs bytes are consumed as part of
 * that capture; this component neither observes nor qualifies a source-files provider.
 * The caller keeps the lock/adapter alive for later verification and owns their cleanup.
 * Published or partial files remain unselected artifacts on failure: no Jq/R/Jr, phase,
 * activation or restore authority is issued, and no source SQL is replayed here.
 */
export async function publishSnapshotBundle(store: ArtifactStore, lock: SourceLock): Promise<{ bundle: ArtifactRef; publication: ArtifactRef }> {
  await lock.assertHeld(); await store.assertRoot();
  const initial = await lock.observe(), state = initial.state;
  requireValue(state.admission === "sealed" && state.journalRecordRef !== null && state.journalDigest !== null, "phase_conflict");
  requireValue(state.controlRootJson === canonicalJson(store.identity) && state.mutexIdentityJson !== null, "control_root_mismatch");
  const anchored = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
  const chain = await verifyJournalChain(store, anchored), head = chain.nodes.at(-1)!;
  requireValue(head.record.formatVersion !== 1 && head.record.event === "capture" && head.record.phase === "quiesced"
    && head.record.frozen !== null && head.record.sourceClients !== null, "phase_conflict");
  const capture = captureReference(head), frozen = head.record.frozen, roster = head.record.sourceClients;
  requireValue(state.databaseInstanceId === capture.source.databaseInstanceId && state.fenceEpoch === capture.fenceEpoch
    && state.ownerGeneration === capture.ownerGeneration && state.activeMigrationId === capture.migrationId
    && state.planDigest === capture.planDigest && state.journalSequence === capture.journalSequence, "maintenance_lost");
  requireValue(same(initial.source, capture.source) && same(initial.sourceIdentity, chain.plan.sourceIdentity)
    && initial.manifests.schemaManifestDigest === frozen.schemaManifestDigest
    && initial.manifests.frozenBusinessManifestDigest === frozen.frozenBusinessManifestDigest
    && state.guardManifestDigest === frozen.guardManifestDigest, "source_changed");
  const files = await readSourceFiles(store, frozen.sourceFilesManifest);
  requireValue(files.rootBindings.every(binding => binding.hostIdentityDigest === store.identity.hostIdentityDigest), "source_changed");
  const assertRoster = async (observed: SourceObservation) => {
    if (head.record.formatVersion === 3) {
      let mutexIdentity: unknown;
      try { mutexIdentity = JSON.parse(state.mutexIdentityJson!); }
      catch { requireValue(false, "control_root_mismatch"); }
      const replay = await replayConsumerSourceControls(store, chain, mutexIdentity);
      await assertVerificationSourceClientBinding(lock, observed, head, observed.manifests, replay);
      return;
    }
    const live = await lock.observeSourceClients();
    requireValue(same(live.source, observed.source) && same(live.sourceIdentity, observed.sourceIdentity)
      && same(live.state, observed.state) && live.schemaManifestDigest === observed.manifests.schemaManifestDigest, "source_changed");
    requireValue(same(buildSourceClientsRoster({ ...roster, source: live.source, textEncoding: live.textEncoding, rows: live.rows }), roster), "source_changed");
  };
  await assertRoster(initial);
  const assertCurrent = async () => {
    await lock.assertHeld();
    const live = await lock.observe();
    requireValue(same(live.source, initial.source) && same(live.sourceIdentity, initial.sourceIdentity)
      && same(live.state, initial.state) && same(live.manifests, initial.manifests), "source_changed");
    await assertRoster(live); await lock.assertHeld();
  };
  // All writes also use the existing store's native root checks and the same actual lock.
  // Complete source/roster comparison brackets the backup and final publication.
  const guarded = await ArtifactStore.open(store.root, initial.source, { assertCurrent: () => lock.assertHeld() });
  requireValue(same(guarded.identity, store.identity), "control_root_mismatch");
  await assertCurrent();
  const attempt = await guarded.createAttempt(state.ownerGeneration);
  const destination = path.join(attempt, initial.source.kind === "sqlite" ? "database.sqlite" : "database.dump");
  const backup = await lock.backup(destination);
  const manifests = parseManifests(backup.manifests);
  requireValue(same(buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows), manifests)
    && same(manifests, initial.manifests), "snapshot_invalid");
  await assertCurrent();
  const database = await guarded.importDatabase(destination);
  const manifestsRef = await guarded.putJson("database-manifests", manifests);
  const capability = await guarded.putJson("capability", await guarded.capability());
  const entries = new Map<string, { role: RestorePayloadRole; object: ArtifactRef }>();
  const add = (role: RestorePayloadRole, object: ArtifactRef) => {
    const prior = entries.get(object.ref);
    requireValue(!prior || prior.role === role && same(prior.object, object), "journal_invalid"); entries.set(object.ref, { role, object });
  };
  add("plan", head.record.plan);
  for (const node of chain.nodes) {
    add(node === head ? "capture-journal" : "journal-prefix", node.reference);
    for (const evidence of node.record.evidence) add("capability-evidence", evidence);
  }
  add("source-files-manifest", frozen.sourceFilesManifest);
  for (const entry of files.entries) if (entry.payload) add("source-file-payload", entry.payload);
  add("database-snapshot", database); add("database-expected-manifests", manifestsRef); add("capability-evidence", capability);
  const body: RestoreBundleManifest = { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: frozen.sourceFilesManifest,
    restorePointDigest: restorePointDigest({ capture, sourceFilesManifest: frozen.sourceFilesManifest, database, manifests: manifestsRef,
      schemaManifestDigest: manifests.schemaManifestDigest, frozenBusinessManifestDigest: manifests.frozenBusinessManifestDigest }), entries: [...entries.values()] };
  await assertCurrent();
  const bundle = await guarded.putJson("restore-bundle", body);
  const observedOperations: PublicationEvidence["observedOperations"][number][] = [];
  for (const reference of [...body.entries.map(entry => entry.object), bundle]) observedOperations.push(await guarded.confirmDurable(reference));
  const publication = await guarded.putJson("publication", { formatVersion: 1, kind: "publication", bundle, capability, observedOperations } satisfies PublicationEvidence);
  await verifyRestoreBundleClosure(guarded, bundle, publication);
  await assertCurrent();
  return { bundle, publication };
}
